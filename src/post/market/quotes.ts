/**
 * 时点报价（设计文档 §5.3）。
 *
 * 三条不能破的规则：
 *   1. 历史成交只能用**事件时点之前**的报价，且这条报价当时真的已经可用
 *      （`available_at <= eventTs`）。用「该分钟结束后才知道的 close」给分钟内
 *      的交易定价就是前视。
 *   2. 距离超过 quoteMaxLagSeconds（默认 120s）视为无价，返回 missing，
 *      绝不用当前 ETH 价回算整段历史。
 *   3. USDG=$1 只是 peg_proxy 假设，必须原样传到卡片和回测记录里。
 */
import { db } from '../../db.js';
import '../store.js';                 // 副作用：确保 post_* 表已建好（顶层 db.prepare 依赖它）
import { VERSIONED_DEFAULTS } from '../config.js';
import type { QuoteQuality } from '../types.js';

export interface QuotePoint {
  source: string; asset: string; quoteTs: number; usd: number;
  availableAt: number; quality: QuoteQuality;
}

const insertQuote = db.prepare(
  `INSERT INTO post_quotes (source, asset, quote_ts, usd, available_at, quality, version)
   VALUES (?,?,?,?,?,?,?)
   ON CONFLICT(source, asset, quote_ts) DO NOTHING`,
);

/** 幂等写入。同一 (source, asset, quoteTs) 重放不会改写历史「当时看到什么」。 */
export function recordQuote(q: QuotePoint, version = 'v1'): void {
  if (!(q.usd > 0) || !Number.isFinite(q.usd)) throw new Error(`报价必须是正数: ${q.asset}=${q.usd}`);
  insertQuote.run(q.source, q.asset, q.quoteTs, q.usd, q.availableAt, q.quality, version);
}

const lookupStmt = db.prepare(
  `SELECT source, asset, quote_ts, usd, available_at, quality FROM post_quotes
   WHERE asset = ? AND quote_ts <= ? AND available_at <= ?
   ORDER BY quote_ts DESC LIMIT 1`,
);

export interface QuoteLookup {
  quoteId: string | null;
  usd: number | null;
  quality: QuoteQuality;
  reason: string;
}

/**
 * 找出给 `eventTs` 这笔成交定价用的报价。
 *
 * `asOf` 是「现在最多能知道到什么时候」——回放时必须传截断时间，否则后来补齐的
 * 历史资料会让回测提前拿到当时还不存在的报价。默认取 eventTs 本身（最严格）。
 */
export function quoteAt(asset: string, eventTs: number, asOf = eventTs): QuoteLookup {
  const maxLagMs = VERSIONED_DEFAULTS.quoteMaxLagSeconds * 1000;
  const row = lookupStmt.get(asset, eventTs, Math.min(asOf, eventTs)) as any;
  if (!row) {
    return { quoteId: null, usd: null, quality: 'missing', reason: `${asset} 在 ${new Date(eventTs).toISOString()} 之前没有已可用的报价` };
  }
  const lag = eventTs - row.quote_ts;
  if (lag > maxLagMs) {
    return {
      quoteId: null, usd: null, quality: 'missing',
      reason: `最近一条 ${asset} 报价距事件 ${Math.round(lag / 1000)}s，超过 ${VERSIONED_DEFAULTS.quoteMaxLagSeconds}s 上限`,
    };
  }
  return {
    quoteId: `${row.source}:${row.asset}:${row.quote_ts}`,
    usd: row.usd,
    quality: row.quality as QuoteQuality,
    reason: `${row.source} ${new Date(row.quote_ts).toISOString()}（滞后 ${Math.round(lag / 1000)}s）`,
  };
}

/**
 * 固定锚定的稳定币。
 *
 * 返回 peg_proxy 而不是 historical——它不是观测到的价格，是个假设。
 * 若将来接入可靠现价且偏离超过 market.stable_peg_deviation_max，
 * 调用方必须停止用固定锚定计算（见 pegBroken）。
 */
export function pegQuote(asset: string, eventTs: number): QuoteLookup {
  return { quoteId: `peg:${asset}:1`, usd: 1, quality: 'peg_proxy', reason: `${asset} 按 $1 固定锚定（peg_proxy 假设，未经现价验证）` };
}

/** 已取得可靠现价时判断锚定是否失效。没有现价就返回 false，不假装验证过。 */
export function pegBroken(observedUsd: number | null, maxDeviation: number): boolean {
  if (observedUsd === null || !Number.isFinite(observedUsd) || observedUsd <= 0) return false;
  return Math.abs(observedUsd - 1) > maxDeviation;
}

/** 给定资产在某段时间内有几条报价——用来说明「本地报价覆盖」到哪里。 */
export function quoteCoverage(asset: string, fromTs: number, toTs: number): { count: number; firstTs: number | null; lastTs: number | null } {
  const r = db.prepare(
    'SELECT COUNT(*) n, MIN(quote_ts) a, MAX(quote_ts) b FROM post_quotes WHERE asset=? AND quote_ts BETWEEN ? AND ?',
  ).get(asset, fromTs, toTs) as any;
  return { count: r.n, firstTs: r.a ?? null, lastTs: r.b ?? null };
}
