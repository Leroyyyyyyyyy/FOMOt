/**
 * 候选注册与分层（设计文档 §5.4）。
 *
 * 分层规则：
 *   所有可识别新池 → 轻量 registry（cold）
 *   过去 15m 有成交的新币、外部/人工 CA → hot（每根闭合 1m 评估）
 *   已进入二段追踪 → 即使最近 5m 安静也留在 watchlist（warm，5m/15m 闭合时评估）
 *
 * 超出预算的候选进**有记录的队列**，不静默截断成「没机会」。
 */
import { db } from '../db.js';
import './store.js';

export type Tier = 'hot' | 'warm' | 'cold';

export interface Candidate {
  chainId: number;
  ca: string;
  symbol: string | null;
  tier: Tier;
  firstTradeTs: number | null;
  ageQuality: 'verified' | 'age_unverified' | 'unknown';
  firstSeenAt: number;
  trackUntil: number | null;
  recentVolumeUsd: number;
  recentSwaps: number;
}

export interface TierConfig {
  hotLimit: number;
  warmLimit: number;
  candidateMaxAgeDays: number;
  newTokenWindowHours: number;      // 新币重点覆盖窗口（默认 24h）
  hotActivityWindowMs: number;      // 「最近有成交」的窗口（默认 15m）
}

export interface TieringResult {
  hot: Candidate[];
  warm: Candidate[];
  /** 超出预算被排队的候选数量。必须报出来，不能假装它们「没机会」。 */
  queuedBeyondBudget: number;
  queuedDetail: { ca: string; reason: string }[];
}

/**
 * 最早可信成交时间。
 * 只能用**本系统已经采集到**的最早成交；采集之前该 token 有没有交易过，
 * 我们不知道——所以覆盖起点之前没有数据时，age 标 age_unverified。
 */
export function firstTradeOf(chainId: number, ca: string): { ts: number | null; quality: Candidate['ageQuality']; evidence: string } {
  const r = db.prepare(
    `SELECT MIN(s.event_ts) t, COUNT(*) n FROM post_swaps s
     JOIN post_pools p ON p.chain_id=s.chain_id AND p.pool_id=s.pool_id
     WHERE s.chain_id=? AND p.ca=?`,
  ).get(chainId, ca.toLowerCase()) as any;
  if (!r?.n) return { ts: null, quality: 'unknown', evidence: '尚无已采集成交' };

  // 该池的 Initialize 必须在我们的覆盖范围内，否则「最早成交」只是我们最早看到的那笔。
  const pool = db.prepare(
    `SELECT MIN(init_block) b, MIN(init_ts) t FROM post_pools WHERE chain_id=? AND ca=?`,
  ).get(chainId, ca.toLowerCase()) as any;
  const cov = db.prepare(
    `SELECT MIN(from_block) b FROM post_coverage WHERE chain_id=? AND pool_id='*' AND status='complete'`,
  ).get(chainId) as any;

  if (pool?.b != null && cov?.b != null && pool.b >= cov.b) {
    return { ts: r.t, quality: 'verified', evidence: `建池区块 ${pool.b} 在覆盖起点 ${cov.b} 之后，首笔成交 ${new Date(r.t).toISOString()}` };
  }
  return {
    ts: r.t, quality: 'age_unverified',
    evidence: '建池早于本地覆盖起点，无法确认该 token 更早是否交易过（老币重建池会被误判成新币）',
  };
}

const upsertTier = db.prepare(
  `UPDATE post_tokens SET tier=?, track_until=?, first_trade_ts=?, first_trade_evidence=?, age_quality=?
   WHERE chain_id=? AND ca=?`,
);

/**
 * 重算分层。返回按预算切好的 hot/warm 列表，超预算的进队列并计数。
 * 排序：已有有效 episode 优先，其次按过去窗口成交额和等待时间。
 */
export function retier(chainId: number, now: number, cfg: TierConfig): TieringResult {
  const activeCas = new Set((db.prepare(
    `SELECT DISTINCT ca FROM post_episodes WHERE chain_id=? AND terminal=0 AND run_id='live'`,
  ).all(chainId) as any[]).map(r => r.ca));

  const rows = db.prepare(
    `SELECT t.chain_id, t.ca, t.symbol, t.first_seen_at, t.tier,
            COALESCE((SELECT SUM(s.volume_usd) FROM post_swaps s
                      JOIN post_pools p ON p.pool_id=s.pool_id AND p.chain_id=s.chain_id
                      WHERE p.ca=t.ca AND s.chain_id=t.chain_id AND s.event_ts >= ?), 0) AS vol,
            COALESCE((SELECT COUNT(*) FROM post_swaps s
                      JOIN post_pools p ON p.pool_id=s.pool_id AND p.chain_id=s.chain_id
                      WHERE p.ca=t.ca AND s.chain_id=t.chain_id AND s.event_ts >= ?), 0) AS swaps
     FROM post_tokens t WHERE t.chain_id=?`,
  ).all(now - cfg.hotActivityWindowMs, now - cfg.hotActivityWindowMs, chainId) as any[];

  const all: Candidate[] = rows.map(r => {
    const ft = firstTradeOf(chainId, r.ca);
    return {
      chainId, ca: r.ca, symbol: r.symbol, tier: 'cold' as Tier,
      firstTradeTs: ft.ts, ageQuality: ft.quality,
      firstSeenAt: r.first_seen_at,
      trackUntil: (ft.ts ?? r.first_seen_at) + cfg.candidateMaxAgeDays * 86_400_000,
      recentVolumeUsd: r.vol, recentSwaps: r.swaps,
    };
  });

  const alive = all.filter(c => (c.trackUntil ?? Infinity) > now);
  const isNew = (c: Candidate) => c.firstTradeTs !== null && now - c.firstTradeTs <= cfg.newTokenWindowHours * 3600_000;

  // hot：活跃新币 + 有活跃 episode 的；按成交额排序，确定性并列按 ca
  const hotPool = alive.filter(c => activeCas.has(c.ca) || (isNew(c) && c.recentSwaps > 0));
  hotPool.sort((a, b) => {
    const ea = activeCas.has(a.ca) ? 0 : 1, eb = activeCas.has(b.ca) ? 0 : 1;
    return ea - eb || b.recentVolumeUsd - a.recentVolumeUsd || (a.ca < b.ca ? -1 : 1);
  });
  const hot = hotPool.slice(0, cfg.hotLimit);

  // warm：其余仍在生命周期内的。二段追踪中的即使最近安静也留在这里。
  const hotSet = new Set(hot.map(c => c.ca));
  const warmPool = alive.filter(c => !hotSet.has(c.ca));
  warmPool.sort((a, b) => {
    const ea = activeCas.has(a.ca) ? 0 : 1, eb = activeCas.has(b.ca) ? 0 : 1;
    return ea - eb || b.recentVolumeUsd - a.recentVolumeUsd || (a.ca < b.ca ? -1 : 1);
  });
  const warm = warmPool.slice(0, cfg.warmLimit);

  const queued = [
    ...hotPool.slice(cfg.hotLimit).map(c => ({ ca: c.ca, reason: `超出 hot 预算 ${cfg.hotLimit}` })),
    ...warmPool.slice(cfg.warmLimit).map(c => ({ ca: c.ca, reason: `超出 warm 预算 ${cfg.warmLimit}` })),
  ];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const c of hot) markTier(c, 'hot');
    for (const c of warm) markTier(c, 'warm');
    for (const c of alive.filter(c => !hotSet.has(c.ca) && !warm.some(w => w.ca === c.ca))) markTier(c, 'cold');
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }

  return { hot: hot.map(c => ({ ...c, tier: 'hot' as Tier })), warm: warm.map(c => ({ ...c, tier: 'warm' as Tier })),
    queuedBeyondBudget: queued.length, queuedDetail: queued.slice(0, 50) };
}

function markTier(c: Candidate, tier: Tier): void {
  const ft = firstTradeOf(c.chainId, c.ca);
  upsertTier.run(tier, c.trackUntil, ft.ts, ft.evidence, ft.quality, c.chainId, c.ca);
}

export function candidate(chainId: number, ca: string): Candidate | null {
  const r = db.prepare('SELECT * FROM post_tokens WHERE chain_id=? AND ca=?').get(chainId, ca.toLowerCase()) as any;
  if (!r) return null;
  return {
    chainId, ca: r.ca, symbol: r.symbol, tier: r.tier as Tier,
    firstTradeTs: r.first_trade_ts, ageQuality: r.age_quality,
    firstSeenAt: r.first_seen_at, trackUntil: r.track_until,
    recentVolumeUsd: 0, recentSwaps: 0,
  };
}

export function candidateCounts(chainId: number): Record<Tier, number> {
  const rows = db.prepare('SELECT tier, COUNT(*) n FROM post_tokens WHERE chain_id=? GROUP BY tier').all(chainId) as any[];
  const out: Record<Tier, number> = { hot: 0, warm: 0, cold: 0 };
  for (const r of rows) if (r.tier in out) out[r.tier as Tier] = r.n;
  return out;
}
