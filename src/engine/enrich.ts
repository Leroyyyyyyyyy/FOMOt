import type { HolderSnapshot } from '../chain/holders.js';
import type { FomoLeader, FomoTokenStats } from '../fomo/provider.js';
import type { LeaderHolder } from '../notify/render.js';

/**
 * 收益有**两个不同的量**，永远不能混用（证据见 docs/FIELDS.md §2）：
 *
 *  - `tokenPnl`：`/hodlers/top.pnl` = `realizedPnl + unrealizedPnl`，
 *    **该币、全时段累计**。50/50 个持有人复算通过。
 *  - `platformPnl24h`：用户**全平台 24H** 收益。榜单 `pnl24h` 是它的实时口径；
 *    任意用户可由 `aggregatedSnapshot` 序列按整点口径算出。
 *
 * 同一用户同一时刻两者可以反号（Binkieee：该币 −6,158 / 全平台24H +552,794），
 * 所以把前者求和标成后者是**假话**。
 */
export interface PlatformPnl {
  /** 全平台 24H 收益 */
  value: number;
  /** 'live' = 榜单实时口径；'snapshot' = 整点对齐口径（滞后 ≤1h） */
  window: 'live' | 'snapshot';
  /** 该值对应的窗口结束时间 */
  asOfTs: number;
}

export interface Enriched {
  available: boolean;
  fomoHolders: number | null;
  leaders: LeaderHolder[];
  leaderboardAvailable: boolean;

  /** Top10 的**该币累计收益**合计（已实现+未实现，全时段）。十人齐全才给值。 */
  top10TokenPnl: number | null;
  /** 拿到该币收益的人数（分母是 top10Count） */
  top10TokenPnlCovered: number;
  /** 按**该币累计收益**统计的盈利人数；与 top10TokenPnl 同口径同窗口。 */
  top10TokenProfitable: number | null;

  /** Top10 的**全平台 24H 收益**合计。十人全部拿到且窗口一致才给值，否则 null。 */
  top10PlatformPnl24h: number | null;
  top10PlatformCovered: number;
  top10PlatformWindow: 'live' | 'snapshot' | 'mixed' | null;

  /** 已识别身份的人数（分子），top10Count 是分母 */
  identified: number;
  /** Top10 集合的**实际**大小。数据缺失与人数不足是两回事，这里只反映实际集合。 */
  top10Count: number;
  /** 全链余额表里能对上 FOMO 身份的唯一地址数 */
  identityCoverage: number;

  /** FOMO 侧数据的采集时间 */
  fomoTakenTs: number | null;
  /** 榜单数据的时间 */
  boardTakenTs: number | null;
  /** 聚合完成时间 */
  aggregatedTs: number | null;
  ingestMs: number | null;
}

export const emptyEnriched = (): Enriched => ({
  available: false, fomoHolders: null, leaders: [], leaderboardAvailable: false,
  top10TokenPnl: null, top10TokenPnlCovered: 0, top10TokenProfitable: null,
  top10PlatformPnl24h: null, top10PlatformCovered: 0, top10PlatformWindow: null,
  identified: 0, top10Count: 0, identityCoverage: 0,
  fomoTakenTs: null, boardTakenTs: null, aggregatedTs: null, ingestMs: null,
});

const userKey = (userId: string | null, handle: string | null) => userId ?? handle ?? '';

export function enrichSocial(
  decimals: number,
  snap: HolderSnapshot | null,
  stats: FomoTokenStats | null,
  board: FomoLeader[],
  leaderboardAvailable = true,
  /** userId → 已**确认**的链上钱包地址。候选映射不进这里。 */
  confirmedWallets = new Map<string, string[]>(),
  /** userId → 全平台 24H 收益。拿不到就没有这一项，绝不用别的量顶替。 */
  platformPnl = new Map<string, PlatformPnl>(),
): Enriched {
  if (!snap || !stats || stats.fomoHolders === null) return emptyEnriched();

  const statsByUser = new Map(stats.top.map(h => [userKey(h.userId, h.handle), h]));

  /**
   * 榜单交集按**稳定 userId** 去重。显示名不是可靠主键——同名用户会被算成一个人，
   * 改名又会被算成两个人。没有 userId 的行退回 handle，但会被标成未确认身份。
   */
  const leaders: LeaderHolder[] = [];
  const seenLeaders = new Set<string>();
  for (const b of board) {
    const key = userKey(b.userId, b.handle);
    if (!key || seenLeaders.has(key)) continue;

    let raw: bigint | undefined;
    const addresses = new Set([
      ...(b.evmAddress ? [b.evmAddress.toLowerCase()] : []),
      ...(b.userId ? confirmedWallets.get(b.userId) ?? [] : []),
    ]);
    for (const address of addresses) {
      const balance = snap.balances.get(address);
      if (balance && balance > 0n) raw = (raw ?? 0n) + balance;
    }

    if (raw && raw > 0n) {
      seenLeaders.add(key);
      leaders.push({ rank: b.rank, handle: b.handle ?? '?', balance: Number(raw) / 10 ** decimals,
        followers: b.followers, pnl24h: b.pnl24h, identityConfirmed: true });
      continue;
    }
    // 链上对不上，但这个人出现在该币的 FOMO 持有人表里——那是 FOMO 自己声明的持仓。
    const h = statsByUser.get(key);
    if (!h) continue;
    seenLeaders.add(key);
    leaders.push({ rank: b.rank, handle: h.handle ?? b.handle ?? '?', balance: h.amount ?? 0,
      followers: h.followers ?? b.followers, pnl24h: b.pnl24h, identityConfirmed: false });
  }
  leaders.sort((a, b) => a.rank - b.rank);

  /**
   * Top10 = `/hodlers/top` 按持仓降序的前十个 **FOMO 持币账户**。
   * 截图证明不了原版取的是这个还是「全链地址前十」，见 docs/FIELDS.md §4。
   *
   * 集合大小取**实际**返回的行数（去重后），不再拿 fomoHolders 或链上 Top 的人数回填——
   * 真实的「只有 6 个人」和「取数失败」必须能区分开。
   */
  const seenTop = new Set<string>();
  const top10: typeof stats.top = [];
  for (const h of stats.top) {
    const key = userKey(h.userId, h.handle) || `#${h.rank}`;
    if (seenTop.has(key)) continue;             // 同一个人不能在 Top10 里占两格
    seenTop.add(key);
    top10.push(h);
    if (top10.length === 10) break;
  }

  const identified = top10.filter(h => Boolean(h.userId || h.handle || h.evmAddress));
  const tokenPnls = top10.map(h => h.pnl).filter((p): p is number => p !== null);
  const tokenComplete = top10.length > 0 && tokenPnls.length === top10.length;

  const platformRows = top10.flatMap(h => {
    const p = h.userId ? platformPnl.get(h.userId) : undefined;
    return p ? [p] : [];
  });
  const windows = new Set(platformRows.map(p => p.window));
  const platformComplete = top10.length > 0 && platformRows.length === top10.length && windows.size === 1;

  const uniqueIdentities = new Set(stats.top.flatMap(h => h.evmAddress ? [h.evmAddress.toLowerCase()] : [])).size;

  return {
    available: true,
    fomoHolders: stats.fomoHolders,
    leaders,
    leaderboardAvailable,

    top10TokenPnl: tokenComplete ? tokenPnls.reduce((a, b) => a + b, 0) : null,
    top10TokenPnlCovered: tokenPnls.length,
    top10TokenProfitable: tokenComplete ? tokenPnls.filter(p => p > 0).length : null,

    top10PlatformPnl24h: platformComplete ? platformRows.reduce((a, p) => a + p.value, 0) : null,
    top10PlatformCovered: platformRows.length,
    top10PlatformWindow: platformRows.length === 0 ? null
      : windows.size === 1 ? [...windows][0]! : 'mixed',

    identified: identified.length,
    top10Count: top10.length,
    identityCoverage: uniqueIdentities,

    fomoTakenTs: stats.takenTs,
    boardTakenTs: board.length ? Math.max(...board.map(b => b.updatedTs)) : null,
    aggregatedTs: Date.now(),
    ingestMs: stats.ingestMs,
  };
}
