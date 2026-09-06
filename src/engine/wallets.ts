import type { HolderSnapshot } from '../chain/holders.js';
import type { FomoTokenStats } from '../fomo/provider.js';
import { db } from '../db.js';
import { chain } from '../config.js';
import { log } from '../logger.js';

/**
 * 钱包 ↔ FOMO 身份的证据链。
 *
 * 金额匹配**只能产生候选**。「两位小数持仓唯一相同」不构成归属证明：
 * 两位小数本身就容易碰撞、FOMO 快照与链上快照存在采样错位、同一个用户可能有多个钱包。
 * 地址上带 EIP-7702 委托代码同样不证明它属于某个 FOMO 用户。
 *
 * 所以：
 *   - `recordAmountCandidates` 写入的一律是 status='candidate'；
 *   - 只有 `confirmLink`（拿到链上 Transfer 溯源等独立证据）才写 'confirmed'；
 *   - 聚合统计（`confirmedWallets`）**只读 confirmed**。
 */
export type LinkStatus = 'candidate' | 'confirmed' | 'conflict' | 'revoked';
export type EvidenceType = 'amount_match_legacy' | 'amount_match' | 'transfer_trace' | 'api_declared';

export interface WalletLink {
  userId: string; address: string; chainId: number;
  status: LinkStatus; evidenceType: EvidenceType; evidenceSrc: string | null;
  observedTs: number; verifiedTs: number | null;
  txHash: string | null; logIndex: number | null; tokenCa: string | null; note: string | null;
}

const selByUsers = db.prepare(
  `SELECT user_id, address FROM fomo_wallet_links
   WHERE status = 'confirmed' AND chain_id = ?`,
);
const selByAddress = db.prepare(
  `SELECT user_id, status FROM fomo_wallet_links WHERE address = ? AND chain_id = ?`,
);
const insCandidate = db.prepare(
  `INSERT INTO fomo_wallet_links
     (user_id, address, chain_id, status, evidence_type, evidence_src, observed_ts, token_ca, note)
   VALUES (?,?,?,'candidate',?,?,?,?,?)
   ON CONFLICT(user_id,address,chain_id) DO UPDATE SET
     observed_ts = excluded.observed_ts,
     token_ca    = excluded.token_ca,
     note        = excluded.note
   WHERE fomo_wallet_links.status = 'candidate'`,   // 已确认/已冲突/已撤销的行不被候选覆盖
);
const markConflict = db.prepare(
  `UPDATE fomo_wallet_links SET status='conflict', note=? WHERE address=? AND chain_id=? AND status IN ('candidate','confirmed')`,
);

/**
 * 聚合用的映射：**只有 confirmed** 的链接。
 * 一个用户可以有多个钱包；按 userId 聚成数组。
 */
export function confirmedWallets(chainId: number = chain.id): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of selByUsers.all(chainId) as { user_id: string; address: string }[]) {
    const list = out.get(r.user_id) ?? [];
    list.push(r.address.toLowerCase());
    out.set(r.user_id, list);
  }
  return out;
}

export interface CandidateStats {
  scanned: number; recorded: number;
  ambiguousAmount: number;      // 金额碰撞，多个地址命中
  conflicting: number;          // 该地址已归属别的用户
  staleSnapshot: boolean;       // 两侧快照时间差太大，本轮不采信
}

/**
 * 金额匹配 → 候选。**永远不会**产出 confirmed。
 *
 * 会拒绝的情况：
 *   - 同一金额命中多个链上地址（两位小数碰撞）；
 *   - FOMO 快照与链上快照相差太久（采样错位）；
 *   - 该地址已经指向另一个 userId（冲突，两边都隔离掉）。
 */
export function recordAmountCandidates(
  decimals: number,
  snap: HolderSnapshot,
  stats: FomoTokenStats,
  tokenCa: string,
  opts: { maxSkewMs?: number; chainId?: number; now?: number } = {},
): CandidateStats {
  const chainId = opts.chainId ?? chain.id;
  const now = opts.now ?? Date.now();
  const maxSkew = opts.maxSkewMs ?? 120_000;
  const out: CandidateStats = { scanned: 0, recorded: 0, ambiguousAmount: 0, conflicting: 0, staleSnapshot: false };

  // 采样错位：链上快照与 FOMO 快照必须足够接近，否则金额相同只是巧合。
  if (Math.abs(snap.takenTs - stats.takenTs) > maxSkew) {
    out.staleSnapshot = true;
    log.debug({ tokenCa, skewMs: Math.abs(snap.takenTs - stats.takenTs) }, '两侧快照时间差过大，本轮不产生钱包候选');
    return out;
  }

  const byCents = new Map<number, string[]>();
  const scale = 10 ** decimals;
  for (const [address, raw] of snap.balances) {
    if (raw <= 0n) continue;
    const cents = Math.round((Number(raw) / scale) * 100);
    if (!Number.isSafeInteger(cents)) continue;
    const list = byCents.get(cents) ?? [];
    list.push(address.toLowerCase());
    byCents.set(cents, list);
  }

  for (const h of stats.top) {
    if (!h.userId || h.amount === null || h.amount <= 0) continue;
    out.scanned++;
    const matches = byCents.get(Math.round(h.amount * 100));
    if (!matches?.length) continue;
    if (matches.length > 1) { out.ambiguousAmount++; continue; }   // 碰撞就不猜
    const address = matches[0]!;

    // 冲突：这个地址已经被记到别的 userId 名下。两边都不能当成身份用。
    const existing = selByAddress.all(address, chainId) as { user_id: string; status: LinkStatus }[];
    const other = existing.find(e => e.user_id !== h.userId && e.status !== 'revoked');
    if (other) {
      markConflict.run(`地址同时被 ${other.user_id} 与 ${h.userId} 命中`, address, chainId);
      out.conflicting++;
      log.warn({ address, a: other.user_id, b: h.userId }, '钱包映射冲突，已隔离');
      continue;
    }

    insCandidate.run(h.userId, address, chainId, 'amount_match',
      `/hodlers/top ${tokenCa}`, now, tokenCa.toLowerCase(),
      `两位小数持仓唯一匹配；链上快照 @block ${snap.atBlock}`);
    out.recorded++;
  }
  return out;
}

/** 拿到独立证据后把候选升级为已确认。没有 txHash 之类的来源就不该调用它。 */
export function confirmLink(
  userId: string, address: string,
  ev: { evidenceType: Exclude<EvidenceType, 'amount_match' | 'amount_match_legacy'>; src: string;
        txHash?: string; logIndex?: number; tokenCa?: string; chainId?: number; now?: number },
): void {
  const chainId = ev.chainId ?? chain.id;
  const now = ev.now ?? Date.now();
  db.prepare(
    `INSERT INTO fomo_wallet_links
       (user_id, address, chain_id, status, evidence_type, evidence_src, observed_ts, verified_ts, tx_hash, log_index, token_ca, note)
     VALUES (?,?,?,'confirmed',?,?,?,?,?,?,?,NULL)
     ON CONFLICT(user_id,address,chain_id) DO UPDATE SET
       status='confirmed', evidence_type=excluded.evidence_type, evidence_src=excluded.evidence_src,
       verified_ts=excluded.verified_ts, tx_hash=excluded.tx_hash, log_index=excluded.log_index`,
  ).run(userId, address.toLowerCase(), chainId, ev.evidenceType, ev.src, now, now,
        ev.txHash ?? null, ev.logIndex ?? null, ev.tokenCa?.toLowerCase() ?? null);
}

/** 撤销一条映射（发现证据不成立时）。历史行保留，只改状态。 */
export function revokeLink(userId: string, address: string, reason: string, chainId: number = chain.id): void {
  db.prepare(`UPDATE fomo_wallet_links SET status='revoked', note=? WHERE user_id=? AND address=? AND chain_id=?`)
    .run(reason.slice(0, 300), userId, address.toLowerCase(), chainId);
}

export function linkCounts(chainId: number = chain.id): Record<LinkStatus, number> {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM fomo_wallet_links WHERE chain_id = ? GROUP BY status')
    .all(chainId) as { status: LinkStatus; n: number }[];
  const out = { candidate: 0, confirmed: 0, conflict: 0, revoked: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}
