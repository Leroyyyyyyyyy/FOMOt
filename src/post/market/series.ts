/**
 * series：主池选择与冻结（设计文档 §5.2）。
 *
 * 一个 episode 固定一个 series，episode 内**禁止静默换池**。主池迁移时
 * 终结旧 episode、开新 series、重新预热——不能把两个池的价格拼成一条曲线，
 * 那会凭空造出突破。
 */
import { createHash } from 'node:crypto';
import { db } from '../../db.js';
import '../store.js';                 // 副作用：确保 post_* 表已建好（顶层 db.prepare 依赖它）
import { VERSIONED_DEFAULTS } from '../config.js';

export interface SeriesRow {
  seriesId: string; chainId: number; ca: string; poolId: string;
  priceSource: string; quotePolicy: string; supplyPolicy: string;
  startedAt: number; endedAt: number | null; endReason: string | null; version: number;
}

/** seriesId 含链、池、价格来源与计价口径版本；换任一项都必须是新 series。 */
export function seriesId(chainId: number, ca: string, poolId: string, priceSource: string, quotePolicy: string, supplyPolicy: string, startedAt: number): string {
  const h = createHash('sha256')
    .update([chainId, ca.toLowerCase(), poolId, priceSource, quotePolicy, supplyPolicy, startedAt].join('|'))
    .digest('hex').slice(0, 16);
  return `S-${chainId}-${h}`;
}

const insert = db.prepare(
  `INSERT INTO post_series (series_id, chain_id, ca, pool_id, price_source, quote_policy, supply_policy, started_at, version)
   VALUES (?,?,?,?,?,?,?,?,1) ON CONFLICT(series_id) DO NOTHING`,
);

export function createSeries(chainId: number, ca: string, poolId: string, startedAt: number,
                             priceSource = 'swap_post_price', quotePolicy = 'timepoint_v1', supplyPolicy = 'timepoint_fdv_v1'): SeriesRow {
  const id = seriesId(chainId, ca, poolId, priceSource, quotePolicy, supplyPolicy, startedAt);
  insert.run(id, chainId, ca.toLowerCase(), poolId, priceSource, quotePolicy, supplyPolicy, startedAt);
  return getSeries(id)!;
}

export function getSeries(id: string): SeriesRow | null {
  const r = db.prepare('SELECT * FROM post_series WHERE series_id=?').get(id) as any;
  return r ? {
    seriesId: r.series_id, chainId: r.chain_id, ca: r.ca, poolId: r.pool_id,
    priceSource: r.price_source, quotePolicy: r.quote_policy, supplyPolicy: r.supply_policy,
    startedAt: r.started_at, endedAt: r.ended_at, endReason: r.end_reason, version: r.version,
  } : null;
}

export function endSeries(id: string, endedAt: number, reason: string): void {
  db.prepare('UPDATE post_series SET ended_at=?, end_reason=? WHERE series_id=? AND ended_at IS NULL')
    .run(endedAt, reason, id);
}

export interface PoolActivity { poolId: string; volumeUsd: number; swaps: number; firstTs: number }

/**
 * 主池选择：截至 `asOf` 的过去 windowSeconds 内成交额最大的**可计价**池。
 * 新币不足一个完整窗口时用已有覆盖窗口，但至少要有 primaryPoolMinWindowSeconds。
 * 并列时按 poolId 字典序，保证确定性（重放必须选到同一个池）。
 */
export function choosePrimaryPool(chainId: number, ca: string, asOf: number, windowSeconds = VERSIONED_DEFAULTS.primaryPoolWindowSeconds):
  { poolId: string; reason: string; candidates: PoolActivity[] } | { poolId: null; reason: string; candidates: PoolActivity[] } {
  const pools = db.prepare('SELECT pool_id FROM post_pools WHERE chain_id=? AND ca=? AND active=1')
    .all(chainId, ca.toLowerCase()) as any[];
  if (!pools.length) return { poolId: null, reason: '该代币还没有已登记的可计价池', candidates: [] };

  const stat = db.prepare(
    `SELECT pool_id AS poolId, COALESCE(SUM(volume_usd),0) AS volumeUsd, COUNT(*) AS swaps, MIN(event_ts) AS firstTs
     FROM post_swaps WHERE chain_id=? AND pool_id=? AND event_ts > ? AND event_ts <= ? AND price_usd IS NOT NULL`,
  );
  let from = asOf - windowSeconds * 1000;
  let candidates = pools.map(p => stat.get(chainId, p.pool_id, from, asOf) as unknown as PoolActivity)
    .filter(c => c.swaps > 0);

  if (!candidates.length) {
    // 新币可能还不足一个完整窗口：退到「有数据以来」，但至少要覆盖最短窗口。
    const earliest = db.prepare(
      `SELECT MIN(event_ts) t FROM post_swaps WHERE chain_id=? AND price_usd IS NOT NULL
         AND pool_id IN (${pools.map(() => '?').join(',')})`,
    ).get(chainId, ...pools.map(p => p.pool_id)) as any;
    const first = earliest?.t ?? null;
    if (first === null) return { poolId: null, reason: '窗口内没有任何已定价成交', candidates: [] };
    if (asOf - first < VERSIONED_DEFAULTS.primaryPoolMinWindowSeconds * 1000) {
      return { poolId: null, reason: `观察窗口不足 ${VERSIONED_DEFAULTS.primaryPoolMinWindowSeconds}s，暂不冻结主池`, candidates: [] };
    }
    from = first;
    candidates = pools.map(p => stat.get(chainId, p.pool_id, from - 1, asOf) as unknown as PoolActivity).filter(c => c.swaps > 0);
    if (!candidates.length) return { poolId: null, reason: '窗口内没有任何已定价成交', candidates: [] };
  }

  candidates.sort((a, b) => b.volumeUsd - a.volumeUsd || (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0));
  const win = candidates[0]!;
  return {
    poolId: win.poolId,
    reason: `过去 ${Math.round((asOf - from) / 1000)}s 成交额最大（$${win.volumeUsd.toFixed(0)}，${win.swaps} 笔）；并列按 poolId 排序`,
    candidates,
  };
}

export interface PriceConflict { conflict: boolean; maxDeviation: number; samples: number; detail: string }

/**
 * 两个池的价格是否持续背离。超过 market.price_conflict_max 就标冲突并暂停确认，
 * **不挑价格高的那个池制造突破**。
 */
export function detectPriceConflict(chainId: number, ca: string, primaryPoolId: string,
                                    fromTs: number, toTs: number, maxDeviation: number): PriceConflict {
  const others = db.prepare('SELECT pool_id FROM post_pools WHERE chain_id=? AND ca=? AND pool_id != ? AND active=1')
    .all(chainId, ca.toLowerCase(), primaryPoolId) as any[];
  if (!others.length) return { conflict: false, maxDeviation: 0, samples: 0, detail: '只有一个活跃池' };

  const avg = db.prepare(
    `SELECT AVG(price_usd) p, COUNT(*) n FROM post_swaps
     WHERE chain_id=? AND pool_id=? AND event_ts >= ? AND event_ts < ? AND price_usd IS NOT NULL`,
  );
  const base = avg.get(chainId, primaryPoolId, fromTs, toTs) as any;
  if (!base?.n || !(base.p > 0)) return { conflict: false, maxDeviation: 0, samples: 0, detail: '主池在该区间没有已定价成交' };

  let worst = 0, samples = 0, who = '';
  for (const o of others) {
    const r = avg.get(chainId, o.pool_id, fromTs, toTs) as any;
    if (!r?.n || !(r.p > 0)) continue;
    samples += r.n;
    const dev = Math.abs(r.p - base.p) / base.p;
    if (dev > worst) { worst = dev; who = o.pool_id; }
  }
  const enough = samples >= VERSIONED_DEFAULTS.priceConflictMinSamples;
  return {
    conflict: enough && worst > maxDeviation,
    maxDeviation: worst,
    samples,
    detail: samples === 0 ? '其它池在该区间没有已定价成交'
      : `与 ${who} 的均价偏离 ${(worst * 100).toFixed(1)}%（阈值 ${(maxDeviation * 100).toFixed(0)}%，样本 ${samples}${enough ? '' : '，样本不足'}）`,
  };
}
