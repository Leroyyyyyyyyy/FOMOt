/**
 * OHLCV 聚合（设计文档 §5.2）。
 *
 * 分工很死：
 *   1m  只能由**真实成交**聚合；5m/15m/1h 只能由**完整的 1m**再聚合。
 *   空桶且扫描完整 → synthetic 平线（沿用上一根 close，volume=0）。
 *   空桶但有缺口/没扫到 → quality=gap(unknown)/pending(partial)，**绝不伪造零量平线**。
 *   synthetic 不算箱体往返、pivot、拉升或突破的证据（由各策略自己拒绝）。
 *
 * 「策略可读」的定义：桶已收盘 **且** 扫描水位越过 closeTs + grace。
 */
import { db } from '../../db.js';
import '../store.js';                 // 副作用：确保 post_* 表已建好（顶层 db.prepare 依赖它）
import type { Candle, Quality, QuoteQuality, Timeframe } from '../types.js';
import { coverageOf } from './coverage.js';
import { supplyAt } from './supply.js';

export const bucketOpen = (ts: number, tfSec: number) => Math.floor(ts / (tfSec * 1000)) * tfSec * 1000;

export interface SeriesRef {
  seriesId: string; chainId: number; ca: string; poolId: string;
}

interface RawBar {
  openTs: number; closeTs: number;
  open: number; high: number; low: number; close: number;
  volumeUsd: number; swaps: number;
  quoteQuality: QuoteQuality;
  lastTs: number;
}

/**
 * 从已定价的成交聚合 1m 原始桶。**只吃 priceUsd 非空的成交**——
 * 没有合规报价的成交不能参与 OHLC，否则会拿 0 或猜的价污染形态。
 */
export function aggregateRaw(
  swaps: { eventTs: number; priceUsd: number | null; volumeUsd: number | null; quoteQuality: QuoteQuality }[],
  tfSec: number,
): Map<number, RawBar> {
  const out = new Map<number, RawBar>();
  // 输入必须已按链上顺序排好；这里不再排序，避免把 (block,txIndex,logIndex) 的顺序
  // 换成按时间排导致同秒事件的 open/close 变得不确定。
  for (const s of swaps) {
    if (s.priceUsd === null || !Number.isFinite(s.priceUsd) || s.priceUsd <= 0) continue;
    const openTs = bucketOpen(s.eventTs, tfSec);
    const b = out.get(openTs);
    if (!b) {
      out.set(openTs, {
        openTs, closeTs: openTs + tfSec * 1000,
        open: s.priceUsd, high: s.priceUsd, low: s.priceUsd, close: s.priceUsd,
        volumeUsd: s.volumeUsd ?? 0, swaps: 1, quoteQuality: s.quoteQuality, lastTs: s.eventTs,
      });
      continue;
    }
    b.high = Math.max(b.high, s.priceUsd);
    b.low = Math.min(b.low, s.priceUsd);
    b.close = s.priceUsd;                       // 输入已按链上顺序，最后一条就是收盘
    b.volumeUsd += s.volumeUsd ?? 0;
    b.swaps++;
    b.lastTs = s.eventTs;
    // 同一桶里混了不同质量的报价，取最弱的那个：peg_proxy 比 live 弱，live 比 historical 弱。
    b.quoteQuality = weakestQuote(b.quoteQuality, s.quoteQuality);
  }
  return out;
}

const QUOTE_RANK: Record<QuoteQuality, number> = { historical: 3, live: 2, peg_proxy: 1, missing: 0 };
export const weakestQuote = (a: QuoteQuality, b: QuoteQuality): QuoteQuality => (QUOTE_RANK[a] <= QUOTE_RANK[b] ? a : b);

const upsertCandle = db.prepare(
  `INSERT INTO post_candles (series_id, timeframe_sec, open_ts, close_ts, available_at,
     open, high, low, close, volume_usd, volume_all_pools_usd, swaps, fdv_close_usd,
     closed, synthetic, quality, source, quote_quality, revision)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(series_id, timeframe_sec, open_ts) DO UPDATE SET
     close_ts=excluded.close_ts, available_at=excluded.available_at,
     open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
     volume_usd=excluded.volume_usd, volume_all_pools_usd=excluded.volume_all_pools_usd,
     swaps=excluded.swaps, fdv_close_usd=excluded.fdv_close_usd,
     closed=excluded.closed, synthetic=excluded.synthetic, quality=excluded.quality,
     source=excluded.source, quote_quality=excluded.quote_quality,
     revision=post_candles.revision + 1`,
);

export interface BuildOptions {
  /** 扫描水位时间：桶结束时间超过它就还不能算「已确认收盘」。 */
  watermarkTs: number;
  /** scan.closed_bar_grace_seconds。工程初值，不代表链的正式最终性。 */
  graceSeconds: number;
  /** 回放截断时间。默认 watermark。 */
  asOf?: number;
  source?: string;
}

/**
 * 把 [fromTs, toTs) 区间内的 1m 桶落库。缺的桶按覆盖状态决定是 synthetic 还是 unknown。
 * 返回写入的桶数。
 */
export function buildMinuteCandles(
  series: SeriesRef,
  swaps: { eventTs: number; priceUsd: number | null; volumeUsd: number | null; quoteQuality: QuoteQuality }[],
  fromTs: number, toTs: number,
  opt: BuildOptions,
): number {
  const tf = 60;
  const raw = aggregateRaw(swaps, tf);
  const start = bucketOpen(fromTs, tf);
  const end = bucketOpen(toTs - 1, tf);
  const asOf = opt.asOf ?? opt.watermarkTs;
  const graceMs = opt.graceSeconds * 1000;

  // 起点之前的最后一根真实 close，作为 synthetic 平线的起点。
  let prevClose = lastRealCloseBefore(series.seriesId, tf, start);
  let written = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let openTs = start; openTs <= end; openTs += tf * 1000) {
      const closeTs = openTs + tf * 1000;
      const bar = raw.get(openTs);
      const closed = closeTs + graceMs <= opt.watermarkTs;
      const cov = coverageOf(series.chainId, series.poolId, openTs, closeTs);
      const supply = supplyAt(series.chainId, series.ca, closeTs, asOf);

      let c: Omit<Candle, 'chainId' | 'ca' | 'poolId' | 'seriesId'>;
      if (bar) {
        const quality: Quality = cov === 'complete' ? 'complete' : cov === 'gap' ? 'partial' : 'partial';
        c = {
          timeframeSec: tf, openTs, closeTs, availableAt: Math.max(closeTs + graceMs, bar.lastTs),
          open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          volumeUsd: bar.volumeUsd, swaps: bar.swaps,
          fdvCloseUsd: supply === null ? null : bar.close * supply,
          closed, synthetic: false, quality,
          source: opt.source ?? 'chain', quoteQuality: bar.quoteQuality, revision: 1,
        };
        prevClose = bar.close;
      } else if (cov === 'complete' && prevClose !== null) {
        // 扫描完整、确实没有成交 → synthetic 平线。这不是证据，只是让时间轴连续。
        c = {
          timeframeSec: tf, openTs, closeTs, availableAt: closeTs + graceMs,
          open: prevClose, high: prevClose, low: prevClose, close: prevClose,
          volumeUsd: 0, swaps: 0,
          fdvCloseUsd: supply === null ? null : prevClose * supply,
          closed, synthetic: true, quality: 'complete',
          source: opt.source ?? 'chain', quoteQuality: 'historical', revision: 1,
        };
      } else {
        // 有缺口 / 还没扫到 / 没有任何前值 —— 只能是 unknown，绝不伪造零量平线。
        c = {
          timeframeSec: tf, openTs, closeTs, availableAt: closeTs + graceMs,
          open: 0, high: 0, low: 0, close: 0,
          volumeUsd: null, swaps: 0, fdvCloseUsd: null,
          closed, synthetic: false, quality: 'unknown',
          source: opt.source ?? 'chain', quoteQuality: 'missing', revision: 1,
        };
      }
      upsertCandle.run(series.seriesId, tf, c.openTs, c.closeTs, c.availableAt,
        c.quality === 'unknown' ? null : c.open, c.quality === 'unknown' ? null : c.high,
        c.quality === 'unknown' ? null : c.low, c.quality === 'unknown' ? null : c.close,
        c.volumeUsd, null, c.swaps, c.fdvCloseUsd,
        c.closed ? 1 : 0, c.synthetic ? 1 : 0, c.quality, c.source, c.quoteQuality, 1);
      written++;
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return written;
}

function lastRealCloseBefore(seriesId: string, tfSec: number, openTs: number): number | null {
  const r = db.prepare(
    `SELECT close FROM post_candles WHERE series_id=? AND timeframe_sec=? AND open_ts < ?
       AND quality != 'unknown' AND synthetic = 0 ORDER BY open_ts DESC LIMIT 1`,
  ).get(seriesId, tfSec, openTs) as any;
  return r?.close ?? null;
}

/**
 * 由完整的 1m 聚合出更高周期。**父桶的可复算性**是硬要求（§14）：
 * 缺任何一根 1m，父桶就不是 complete。
 */
export function rollUp(series: SeriesRef, tf: Timeframe, fromTs: number, toTs: number, opt: BuildOptions): number {
  if (tf === 60) throw new Error('rollUp 只用于 5m/15m/1h');
  const start = bucketOpen(fromTs, tf);
  const end = bucketOpen(toTs - 1, tf);
  const perParent = tf / 60;
  const graceMs = opt.graceSeconds * 1000;
  let written = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let openTs = start; openTs <= end; openTs += tf * 1000) {
      const closeTs = openTs + tf * 1000;
      const kids = db.prepare(
        `SELECT * FROM post_candles WHERE series_id=? AND timeframe_sec=60 AND open_ts >= ? AND open_ts < ?
         ORDER BY open_ts`,
      ).all(series.seriesId, openTs, closeTs) as any[];

      const missing = perParent - kids.length;
      const anyUnknown = kids.some(k => k.quality === 'unknown');
      const real = kids.filter(k => k.quality !== 'unknown' && !k.synthetic);
      const usable = kids.filter(k => k.quality !== 'unknown');
      const closed = closeTs + graceMs <= opt.watermarkTs;

      if (missing > 0 || anyUnknown || !usable.length) {
        upsertCandle.run(series.seriesId, tf, openTs, closeTs, closeTs + graceMs,
          null, null, null, null, null, null, 0, null,
          closed ? 1 : 0, 0, 'unknown', opt.source ?? 'chain', 'missing', 1);
        written++;
        continue;
      }

      const first = usable[0], last = usable[usable.length - 1];
      const high = Math.max(...usable.map(k => k.high));
      const low = Math.min(...usable.map(k => k.low));
      const volume = usable.reduce((s, k) => s + (k.volume_usd ?? 0), 0);
      const swaps = usable.reduce((s, k) => s + k.swaps, 0);
      const quoteQuality = usable.map(k => k.quote_quality as QuoteQuality).reduce(weakestQuote, 'historical' as QuoteQuality);
      const synthetic = real.length === 0;       // 整根都是 synthetic 才算 synthetic
      const supply = supplyAt(series.chainId, series.ca, closeTs, opt.asOf ?? opt.watermarkTs);

      upsertCandle.run(series.seriesId, tf, openTs, closeTs, closeTs + graceMs,
        first.open, high, low, last.close, volume, null, swaps,
        supply === null ? null : last.close * supply,
        closed ? 1 : 0, synthetic ? 1 : 0, 'complete', opt.source ?? 'chain', quoteQuality, 1);
      written++;
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return written;
}

export interface LoadOptions {
  /** 只返回策略可读的桶：已收盘、可用时间 ≤ asOf。默认 true。 */
  closedOnly?: boolean;
  asOf?: number;
  limit?: number;
}

/**
 * 读取策略要用的 K 线。
 * `asOf` 是无前视的关键：回放时只能看到 available_at ≤ asOf 的桶。
 */
export function loadCandles(seriesId: string, tf: Timeframe, fromTs: number, toTs: number, opt: LoadOptions = {}): Candle[] {
  const closedOnly = opt.closedOnly !== false;
  const rows = db.prepare(
    `SELECT c.*, s.chain_id, s.ca, s.pool_id FROM post_candles c JOIN post_series s ON s.series_id = c.series_id
     WHERE c.series_id=? AND c.timeframe_sec=? AND c.open_ts >= ? AND c.open_ts < ?
       ${closedOnly ? 'AND c.closed = 1' : ''}
       ${opt.asOf !== undefined ? 'AND c.available_at <= ' + Number(opt.asOf) : ''}
     ORDER BY c.open_ts ${opt.limit ? 'DESC LIMIT ' + Number(opt.limit) : ''}`,
  ).all(seriesId, tf, fromTs, toTs) as any[];
  const out = rows.map(toCandle);
  return opt.limit ? out.reverse() : out;
}

function toCandle(r: any): Candle {
  return {
    chainId: r.chain_id, ca: r.ca, poolId: r.pool_id, seriesId: r.series_id,
    timeframeSec: r.timeframe_sec, openTs: r.open_ts, closeTs: r.close_ts, availableAt: r.available_at,
    open: r.open, high: r.high, low: r.low, close: r.close,
    volumeUsd: r.volume_usd, swaps: r.swaps, volumeAllPoolsUsd: r.volume_all_pools_usd,
    fdvCloseUsd: r.fdv_close_usd,
    closed: !!r.closed, synthetic: !!r.synthetic, quality: r.quality as Quality,
    source: r.source, quoteQuality: r.quote_quality as QuoteQuality, revision: r.revision,
  };
}

/** 一段 K 线里「有真实成交的桶」占比。低于 market.real_bar_ratio_min 就不能当有效横盘。 */
export function realBarRatio(candles: Candle[]): number {
  if (!candles.length) return 0;
  return candles.filter(c => !c.synthetic && c.quality !== 'unknown' && c.swaps > 0).length / candles.length;
}

/** 真实成交桶（形态判定只认这些）。 */
export const realBars = (candles: Candle[]): Candle[] =>
  candles.filter(c => !c.synthetic && c.quality !== 'unknown' && c.swaps > 0);

/** 区间内有没有 unknown 桶——有就说明数据不完整，形态不能确认。 */
export const hasUnknown = (candles: Candle[]): boolean => candles.some(c => c.quality === 'unknown');
