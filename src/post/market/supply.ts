/**
 * 供应量时点快照与 FDV（设计文档 §5.3）。
 *
 * 现有 `marketCapUsd` 其实是 price × totalSupply，没有流通供应量证据，
 * 所以 post 侧统一叫 **FDV（市值代理）**，且历史 FDV 只能用当时的供应量，
 * 不能拿今天的供应量倒算过去。证明不了就保持 null（→ 3–5M / 1–2M 条件 unknown）。
 */
import { db } from '../../db.js';
import '../store.js';                 // 副作用：确保 post_* 表已建好（顶层 db.prepare 依赖它）

const insert = db.prepare(
  `INSERT INTO post_supplies (chain_id, ca, observed_block, total_supply, decimals, observed_ts, available_at, source)
   VALUES (?,?,?,?,?,?,?,?)
   ON CONFLICT(chain_id, ca, observed_block) DO NOTHING`,
);

export function recordSupply(chainId: number, ca: string, observedBlock: number, totalSupply: bigint,
                             decimals: number, observedTs: number, availableAt: number, source: string): void {
  insert.run(chainId, ca.toLowerCase(), observedBlock, totalSupply.toString(), decimals, observedTs, availableAt, source);
}

const lookup = db.prepare(
  `SELECT total_supply, decimals, observed_ts FROM post_supplies
   WHERE chain_id=? AND ca=? AND observed_ts <= ? AND available_at <= ?
   ORDER BY observed_ts DESC LIMIT 1`,
);

/**
 * 某时点的人类单位供应量。没有当时的快照就返回 null——
 * 调用方据此把 FDV 标 null，而不是拿最新供应量凑一个数。
 */
export function supplyAt(chainId: number, ca: string, ts: number, asOf = ts): number | null {
  const r = lookup.get(chainId, ca.toLowerCase(), ts, Math.min(asOf, ts)) as any;
  if (!r) return null;
  const n = Number(BigInt(r.total_supply)) / 10 ** r.decimals;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 供应量在某段时间内是否发生过变化。变了就不能把 FDV 新高当价格突破（§14）。 */
export function supplyChanged(chainId: number, ca: string, fromTs: number, toTs: number): boolean {
  const rows = db.prepare(
    `SELECT DISTINCT total_supply FROM post_supplies WHERE chain_id=? AND ca=? AND observed_ts BETWEEN ? AND ?`,
  ).all(chainId, ca.toLowerCase(), fromTs, toTs) as any[];
  return rows.length > 1;
}

/** FDV（市值代理）。卡片必须写成「FDV（市值代理）」，不能写成流通市值。 */
export function fdvUsd(priceUsd: number, supply: number | null): number | null {
  if (supply === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const v = priceUsd * supply;
  return Number.isFinite(v) ? v : null;
}
