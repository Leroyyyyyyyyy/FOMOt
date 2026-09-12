/**
 * 采集覆盖与水位（设计文档 §5.3）。
 *
 * 水位的定义是「**连续**完成至此」，不是见过的最大 block。区别很关键：
 * watcher 落后超过一小时会直接跳到最近一小时重扫，跳过的那段如果只更新最大
 * block，缺口就永远消失了，而策略会以为自己看到了完整的横盘。
 */
import { db } from '../../db.js';
import '../store.js';                 // 副作用：确保 post_* 表已建好（顶层 db.prepare 依赖它）

export type CoverageStatus = 'complete' | 'gap' | 'pending';
export type Stream = 'realtime' | 'backfill';

export interface Interval { fromBlock: number; toBlock: number; fromTs: number | null; toTs: number | null; status: CoverageStatus }

const upsert = db.prepare(
  `INSERT INTO post_coverage (chain_id, pool_id, stream, from_block, to_block, from_ts, to_ts, last_hash, status, note)
   VALUES (?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(chain_id, pool_id, stream, from_block) DO UPDATE SET
     to_block = MAX(post_coverage.to_block, excluded.to_block),
     to_ts    = MAX(COALESCE(post_coverage.to_ts, 0), COALESCE(excluded.to_ts, 0)),
     last_hash = excluded.last_hash,
     status   = excluded.status,
     note     = excluded.note`,
);

/** 记录一段已完成扫描的区间。相邻/重叠的 complete 区间随后由 compact 合并。 */
export function recordInterval(
  chainId: number, poolId: string, stream: Stream,
  fromBlock: number, toBlock: number, fromTs: number | null, toTs: number | null,
  status: CoverageStatus = 'complete', lastHash: string | null = null, note: string | null = null,
): void {
  upsert.run(chainId, poolId, stream, fromBlock, toBlock, fromTs, toTs, lastHash, status, note);
  if (status === 'complete') compact(chainId, poolId, stream);
}

/** 合并相邻或重叠的 complete 区间，避免碎片把「连续」判成一堆缺口。 */
export function compact(chainId: number, poolId: string, stream: Stream): void {
  const rows = db.prepare(
    `SELECT * FROM post_coverage WHERE chain_id=? AND pool_id=? AND stream=? AND status='complete' ORDER BY from_block`,
  ).all(chainId, poolId, stream) as any[];
  if (rows.length < 2) return;
  const merged: any[] = [];
  for (const r of rows) {
    const last = merged[merged.length - 1];
    if (last && r.from_block <= last.to_block + 1) {
      last.to_block = Math.max(last.to_block, r.to_block);
      last.to_ts = Math.max(last.to_ts ?? 0, r.to_ts ?? 0) || null;
      last.last_hash = r.last_hash ?? last.last_hash;
    } else merged.push({ ...r });
  }
  if (merged.length === rows.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM post_coverage WHERE chain_id=? AND pool_id=? AND stream=? AND status='complete'`)
      .run(chainId, poolId, stream);
    for (const m of merged) {
      upsert.run(chainId, poolId, stream, m.from_block, m.to_block, m.from_ts, m.to_ts, m.last_hash, 'complete', m.note);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

/**
 * 某个池的覆盖区间。
 *
 * 包含 `pool_id='*'` 的**全链级**区间：post 的实时扫描是对 PoolManager 整体
 * 做一次 getLogs，扫过那段区块就等于扫过了该范围内**所有**池——包括那段时间
 * 里一笔成交都没有的池。这正是「扫描完整但没有成交 → synthetic 平线」
 * 与「有缺口 → unknown」能被区分开的依据。
 */
export function intervals(chainId: number, poolId: string): Interval[] {
  const rows = db.prepare(
    `SELECT from_block, to_block, from_ts, to_ts, status FROM post_coverage
     WHERE chain_id=? AND (pool_id=? OR pool_id='*') ORDER BY from_block`,
  ).all(chainId, poolId) as any[];
  return rows.map(r => ({ fromBlock: r.from_block, toBlock: r.to_block, fromTs: r.from_ts, toTs: r.to_ts, status: r.status }));
}

/**
 * 某个时间区间的覆盖结论。
 *   complete = 被一段连续的 complete 区间完整包住；
 *   gap      = 与已知缺口相交，或被多段不相连的 complete 区间勉强拼起来；
 *   pending  = 还没扫到这里。
 *
 * 注意 `gap` 与 `pending` 必须分开：前者是「扫过但缺数据」，后者是「还没轮到」，
 * 两者对策略的含义不同（一个可能永远补不上，一个只是等）。
 */
export function coverageOf(chainId: number, poolId: string, fromTs: number, toTs: number): CoverageStatus {
  const all = intervals(chainId, poolId);
  if (!all.length) return 'pending';
  for (const iv of all) {
    if (iv.status !== 'complete') continue;
    if (iv.fromTs !== null && iv.toTs !== null && iv.fromTs <= fromTs && iv.toTs >= toTs) return 'complete';
  }
  // 明确记为 gap 的区间与目标相交 → gap
  const overlapsGap = all.some(iv => iv.status === 'gap' && iv.fromTs !== null && iv.toTs !== null
    && iv.fromTs < toTs && iv.toTs > fromTs);
  if (overlapsGap) return 'gap';
  // 有 complete 区间与目标相交但没包住 → 部分覆盖，同样不能当完整
  const partial = all.some(iv => iv.status === 'complete' && iv.fromTs !== null && iv.toTs !== null
    && iv.fromTs < toTs && iv.toTs > fromTs);
  return partial ? 'gap' : 'pending';
}

/** 连续水位：从最早的 complete 区间起一路相连能到的最大 block / 时间。 */
export function watermark(chainId: number, poolId: string, stream: Stream): { block: number | null; ts: number | null } {
  const rows = db.prepare(
    `SELECT from_block, to_block, to_ts FROM post_coverage
     WHERE chain_id=? AND pool_id=? AND stream=? AND status='complete' ORDER BY from_block`,
  ).all(chainId, poolId, stream) as any[];
  if (!rows.length) return { block: null, ts: null };
  let block = rows[0].to_block, ts = rows[0].to_ts ?? null;
  for (const r of rows.slice(1)) {
    if (r.from_block > block + 1) break;                 // 断开了，水位就到这
    if (r.to_block > block) { block = r.to_block; ts = r.to_ts ?? ts; }
  }
  return { block, ts };
}

/** 记录一段被跳过的区间，并排进回补队列。缺口没补好之前不得发形态确认（§3）。 */
export function recordGap(chainId: number, poolId: string, fromBlock: number, toBlock: number,
                          fromTs: number | null, toTs: number | null, note: string): void {
  upsert.run(chainId, poolId, 'realtime', fromBlock, toBlock, fromTs, toTs, null, 'gap', note);
}

export function openGaps(chainId: number, limit = 100): { poolId: string; fromBlock: number; toBlock: number; note: string | null }[] {
  return db.prepare(
    `SELECT pool_id AS poolId, from_block AS fromBlock, to_block AS toBlock, note
     FROM post_coverage WHERE chain_id=? AND status='gap' ORDER BY from_block LIMIT ?`,
  ).all(chainId, limit) as any[];
}

/** 缺口补上后清掉这条 gap 记录，并把它转成 complete。 */
export function closeGap(chainId: number, poolId: string, fromBlock: number, toBlock: number, fromTs: number | null, toTs: number | null): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM post_coverage WHERE chain_id=? AND pool_id=? AND status='gap' AND from_block=?`)
      .run(chainId, poolId, fromBlock);
    upsert.run(chainId, poolId, 'backfill', fromBlock, toBlock, fromTs, toTs, null, 'complete', '缺口已回补');
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  compact(chainId, poolId, 'backfill');
}
