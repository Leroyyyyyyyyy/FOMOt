import type { HolderSnapshot } from '../chain/holders.js';
import type { FomoLeader, FomoTokenStats } from '../fomo/provider.js';
import type { LeaderHolder } from '../notify/render.js';
import { aggregatePnl, emptyAggregate, type PnlAggregate, type PnlRecord, type PnlWindow } from './pnl.js';

export type { PnlRecord, PnlWindow } from './pnl.js';

/**
 * 收益有**两个不同的量**，永远不能混用（证据见 docs/FIELDS.md §2）：
 *
 *  - `tokenPnl`：`/hodlers/top.pnl` = `realizedPnl + unrealizedPnl`，
 *    **该币、全时段累计**。50/50 个持有人复算通过。
 *  - 全平台 24H：用户**跨所有代币**的 24 小时收益，数据契约见 `./pnl.ts`。
 *
 * 同一用户同一时刻两者可以反号（Binkieee：该币 −6,158 / 全平台24H +552,794），
 * 所以把前者求和标成后者是**假话**，两者的盈利人数也各算各的。
 */

/** Top10 成员集合的可信度。「真的只有 3 个人」和「只采到 3 行」是两回事。 */
export type Top10SetStatus = 'ok' | 'empty' | 'incomplete';

export interface Top10Member {
  rank: number;
  userId: string | null;
  handle: string | null;
  evmAddress: string | null;
}

export interface Enriched {
  available: boolean;
  fomoHolders: number | null;
  leaders: LeaderHolder[];
  leaderboardAvailable: boolean;

  /** Top10 的**该币累计收益**合计（已实现+未实现，全时段）。人数齐全才给值。 */
  top10TokenPnl: number | null;
  /** 拿到该币收益的人数（分母是 top10Count） */
  top10TokenPnlCovered: number;
  /** 按**该币累计收益**统计的盈利人数；与 top10TokenPnl 同口径同窗口。 */
  top10TokenProfitable: number | null;

  /** Top10 的**全平台 24H 收益**合计。成员齐全、口径一致、窗口一致才给值。 */
  top10PlatformPnl24h: number | null;
  /** 全平台 24H 口径下的**盈利人数**——独立字段，绝不复用该币的盈利人数。 */
  top10PlatformProfitable24h: number | null;
  top10PlatformCovered: number;
  /** 这批记录共同的窗口（口径 + 起止时间）。不一致时为 null。 */
  top10PlatformWindow: PnlWindow | null;
  /** 缺失原因。有 n/a 就一定有原因。 */
  top10PlatformReason: string | null;
  /** 全平台收益这批记录的获取完成时间，与窗口结束时间分开。 */
  top10PlatformFetchedTs: number | null;

  /** 已识别身份的人数（分子），top10Count 是分母 */
  identified: number;
  /** Top10 集合的**实际**大小。数据缺失与人数不足是两回事，这里只反映实际集合。 */
  top10Count: number;
  /** 这个集合是否可信完整（真实零人 / 采集不完整要能分开） */
  top10SetStatus: Top10SetStatus;
  /** Top10 成员表：预取和「成员是否变化」的判断都以它为准。 */
  top10Members: Top10Member[];
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
  top10PlatformPnl24h: null, top10PlatformProfitable24h: null, top10PlatformCovered: 0,
  top10PlatformWindow: null, top10PlatformReason: 'FOMO 数据不可用', top10PlatformFetchedTs: null,
  identified: 0, top10Count: 0, top10SetStatus: 'incomplete', top10Members: [], identityCoverage: 0,
  fomoTakenTs: null, boardTakenTs: null, aggregatedTs: null, ingestMs: null,
});

const userKey = (userId: string | null, handle: string | null) => userId ?? handle ?? '';

/** Top10 成员集合是否一致（顺序无关，按 userId）。复用预取结果的前提之一。 */
export function sameMembers(a: Top10Member[], b: Top10Member[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(m => m.userId ?? `#${m.rank}`).sort();
  const kb = b.map(m => m.userId ?? `#${m.rank}`).sort();
  return ka.every((k, i) => k === kb[i]);
}

export function memberIds(members: Top10Member[]): (string | null)[] {
  return members.map(m => m.userId);
}

export function enrichSocial(
  decimals: number,
  snap: HolderSnapshot | null,
  stats: FomoTokenStats | null,
  board: FomoLeader[],
  leaderboardAvailable = true,
  /** userId → 已**确认**的链上钱包地址。候选映射不进这里。 */
  confirmedWallets = new Map<string, string[]>(),
  /**
   * userId → 全平台 24H 收益记录。
   *
   * **只接受同一次聚合、同一目标窗口下产出的记录**（校验在 aggregatePnl 里）。
   * 榜单的实时口径 `pnl24h` **不**从这里补入：它的窗口右端是抓取时刻，
   * 和整点口径不是同一个 24 小时，混进来求和就是假话（见 ./pnl.ts 顶部注释）。
   */
  platformPnl = new Map<string, PnlRecord>(),
  nowTs = Date.now(),
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
   * 真实的「只有 6 个人」和「取数失败」必须能区分开，这就是 top10SetStatus。
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
  const members: Top10Member[] = top10.map(h => ({
    rank: h.rank, userId: h.userId, handle: h.handle, evmAddress: h.evmAddress,
  }));

  /**
   * 集合可信度。`/hodlers/top` 声称有 N 个 FOMO 持币人却一行都没返回，
   * 那是采集不完整，不是「这个币真的没人持有」。
   */
  const claimed = stats.fomoHolders;
  const expectedRows = Math.min(10, claimed);
  const setStatus: Top10SetStatus =
    top10.length === 0 ? (claimed === 0 ? 'empty' : 'incomplete')
    : top10.length >= expectedRows ? 'ok'
    : 'incomplete';

  const identified = top10.filter(h => Boolean(h.userId || h.handle || h.evmAddress));
  const tokenPnls = top10.map(h => h.pnl).filter((p): p is number => p !== null && Number.isFinite(p));
  const tokenComplete = top10.length > 0 && setStatus === 'ok' && tokenPnls.length === top10.length;

  /**
   * 全平台 24H：成员完整性、数值有效性、口径一致性、窗口一致性四项一起校验。
   * 集合本身就不完整时直接判缺失——十个人里少一个和「成员列表没采全」都不能求和。
   */
  const platform: PnlAggregate = setStatus === 'empty'
    ? emptyAggregate(0, '该币 FOMO 侧无持币人')
    : setStatus === 'incomplete'
      ? emptyAggregate(top10.length, `Top10 成员列表不完整（声称 ${claimed} 人，只取到 ${top10.length} 行）`)
      : aggregatePnl(memberIds(members), platformPnl, nowTs);

  const uniqueIdentities = new Set(stats.top.flatMap(h => h.evmAddress ? [h.evmAddress.toLowerCase()] : [])).size;

  return {
    available: true,
    fomoHolders: stats.fomoHolders,
    leaders,
    leaderboardAvailable,

    top10TokenPnl: tokenComplete ? tokenPnls.reduce((a, b) => a + b, 0) : null,
    top10TokenPnlCovered: tokenPnls.length,
    top10TokenProfitable: tokenComplete ? tokenPnls.filter(p => p > 0).length : null,

    top10PlatformPnl24h: platform.total,
    top10PlatformProfitable24h: platform.profitable,
    top10PlatformCovered: platform.covered,
    top10PlatformWindow: platform.window,
    top10PlatformReason: platform.reason,
    top10PlatformFetchedTs: platform.fetchedTs,

    identified: identified.length,
    top10Count: top10.length,
    top10SetStatus: setStatus,
    top10Members: members,
    identityCoverage: uniqueIdentities,

    fomoTakenTs: stats.takenTs,
    boardTakenTs: board.length ? Math.max(...board.map(b => b.updatedTs)) : null,
    aggregatedTs: nowTs,
    ingestMs: stats.ingestMs,
  };
}

/**
 * 只替换全平台 24H 那几项，其余字段（含持币快照时间与偏移）原样保留。
 *
 * 「后续仅补充 PnL」这条路径必须走这里：补一个字段不能顺带改动整张卡片的观察时点。
 */
export function withPlatformPnl(e: Enriched, records: ReadonlyMap<string, PnlRecord>, nowTs = Date.now()): Enriched {
  if (!e.available) return e;
  const agg: PnlAggregate = e.top10SetStatus === 'empty'
    ? emptyAggregate(0, '该币 FOMO 侧无持币人')
    : e.top10SetStatus === 'incomplete'
      ? emptyAggregate(e.top10Count, 'Top10 成员列表不完整')
      : aggregatePnl(memberIds(e.top10Members), records, nowTs);
  return {
    ...e,
    top10PlatformPnl24h: agg.total,
    top10PlatformProfitable24h: agg.profitable,
    top10PlatformCovered: agg.covered,
    top10PlatformWindow: agg.window,
    top10PlatformReason: agg.reason,
    top10PlatformFetchedTs: agg.fetchedTs,
  };
}
