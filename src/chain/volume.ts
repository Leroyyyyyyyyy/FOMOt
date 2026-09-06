import { db } from '../db.js';

export interface PoolRef {
  poolId: string; ca: string; quote: string;
  tokenIs0: boolean; quoteDecimals: number; quoteUsd: number;
}

/** 把一条 Swap 的 quote 侧数量换算成美元。V4 的 amount 是有符号的，取绝对值。 */
export function swapUsd(amount0: bigint, amount1: bigint, tokenIs0: boolean, quoteDecimals: number, quoteUsd: number): number {
  const q = tokenIs0 ? amount1 : amount0;
  const abs = q < 0n ? -q : q;
  return (Number(abs) / 10 ** quoteDecimals) * quoteUsd;
}

const insertSwap = db.prepare(
  'INSERT OR IGNORE INTO swaps (pool_id, block, log_idx, ts, usd) VALUES (?, ?, ?, ?, ?)',
);
export function recordSwap(poolId: string, block: bigint, logIdx: number, ts: number, usd: number): void {
  insertSwap.run(poolId, Number(block), logIdx, ts, usd);
}

const volumeQ = db.prepare(`
  SELECT COALESCE(SUM(s.usd), 0) AS v
  FROM swaps s JOIN pools p ON p.pool_id = s.pool_id
  WHERE p.ca = ? AND s.ts >= ?
`);
/** 某个代币在滚动窗口内的成交量（跨它所有的池求和）。 */
export function volumeUsd(ca: string, windowMs: number): number {
  const row = volumeQ.get(ca.toLowerCase(), Date.now() - windowMs) as { v: number } | undefined;
  return row?.v ?? 0;
}

const txCountQ = db.prepare(`
  SELECT COUNT(*) AS n FROM swaps s JOIN pools p ON p.pool_id = s.pool_id
  WHERE p.ca = ? AND s.ts >= ?
`);
export function swapCount(ca: string, windowMs: number): number {
  return (txCountQ.get(ca.toLowerCase(), Date.now() - windowMs) as { n: number }).n;
}

/** 最近有成交的代币 = 候选池。原版是按节拍扫这样一个集合，而不是逐事件触发。 */
const activeQ = db.prepare(`
  SELECT p.ca AS ca, COUNT(*) AS swaps, SUM(s.usd) AS usd
  FROM swaps s JOIN pools p ON p.pool_id = s.pool_id
  WHERE s.ts >= ?
  GROUP BY p.ca
  HAVING usd > 0
  ORDER BY usd DESC
  LIMIT ?
`);
export function activeTokens(windowMs: number, limit = 300): { ca: string; swaps: number; usd: number }[] {
  return activeQ.all(Date.now() - windowMs, limit) as any[];
}
