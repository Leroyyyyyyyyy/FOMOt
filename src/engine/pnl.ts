/**
 * 全平台 24H 收益的**数据契约与窗口校验**。
 *
 * 背景（证据见 docs/FIELDS.md §2）：收益有两个不同的量，永远不能混用——
 *  - `/hodlers/top.pnl`：**该币、全时段累计**收益（realizedPnl + unrealizedPnl）；
 *  - 全平台 24H 收益：用户跨所有代币的 24 小时收益。
 *
 * 后者又有**两个口径**，窗口不同，不能相加：
 *  - `live`（榜单 `pnl24h`）：实时累计值减 24 小时前整点快照，窗口右端是**抓取那一刻**；
 *  - `snapshot`（`aggregatedSnapshot` 序列）：两端都对齐整点，右端滞后 ≤1 小时。
 *
 * 这个模块只做三件事，且都不碰网络：
 *  1. 定义一条收益记录必须携带的字段（来源、口径、窗口起止、**实际获取时间**）；
 *  2. 从原始序列里**严格**推导一条记录——找不到精确的起点/终点就返回缺失，
 *     绝不用更早的点顶替（那会把 25 小时标成 24H）；
 *  3. 聚合前校验成员完整性、数值有效性、口径一致性、窗口一致性。
 *
 * 关键约定：`fetchedTs`（刚抓到）与 `windowEndTs`（数据截止）是**两个**字段。
 * 「刚抓到」不等于「数据最新」——整点口径抓到手时窗口右端可能已经是 59 分钟前。
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const DAY_SEC = 86_400;

/** 整点锚点最多可以比目标整点早多少——超过就不是「同一次聚合的窗口」了。 */
export const MAX_ANCHOR_LAG_MS = HOUR_MS;
/** 聚合时窗口右端离现在最多多久。整点口径天然滞后 ≤1h，再留 1h 余量。 */
export const MAX_WINDOW_AGE_MS = 2 * HOUR_MS;

/** 'live' = 榜单实时口径；'snapshot' = 两端对齐整点的口径 */
export type PnlBasis = 'live' | 'snapshot';
export type PnlSource = 'aggregated_snapshot' | 'leaderboard_24h';

export interface PnlWindow {
  basis: PnlBasis;
  /** 窗口开始时间（毫秒） */
  startTs: number;
  /** 窗口结束时间（毫秒）。**不是**获取时间。 */
  endTs: number;
}

/** 一条逐人收益记录。字段少一个都不足以证明「这十个人算的是同一个 24 小时」。 */
export interface PnlRecord {
  userId: string;
  value: number;
  source: PnlSource;
  basis: PnlBasis;
  windowStartTs: number;
  windowEndTs: number;
  /** 实际获取（本地拿到数据）的时间。与 windowEndTs 严格分开。 */
  fetchedTs: number;
}

/** 单个用户拿不到记录的原因。缺失必须有名字，不能退化成「没有」。 */
export type PnlMiss =
  | 'no_series'            // 根本没拿到序列
  | 'no_end_point'         // 序列里没有目标窗口右端那个整点
  | 'no_start_point'       // 没有精确起点——**不接受更早的点**
  | 'conflicting_points'   // 同一整点出现两个不同的值
  | 'invalid_value'        // 非有限数值
  | 'bad_window';          // 目标窗口本身不是 24 小时

export const MISS_TEXT: Record<PnlMiss, string> = {
  no_series: '未取到收益序列',
  no_end_point: '序列缺目标窗口终点',
  no_start_point: '序列缺精确的 24 小时起点',
  conflicting_points: '同一整点存在冲突数值',
  invalid_value: '收益数值非有限',
  bad_window: '目标窗口不是 24 小时',
};

export interface SeriesPoint { snapshotId: number; pnl: number }

/** 窗口是否恰好 24 小时且两端都在整点上。 */
export function isDayWindow(w: PnlWindow): boolean {
  return Number.isFinite(w.startTs) && Number.isFinite(w.endTs)
    && w.endTs - w.startTs === DAY_MS
    && w.endTs % HOUR_MS === 0 && w.startTs % HOUR_MS === 0;
}

export function sameWindow(a: PnlWindow, b: PnlWindow): boolean {
  return a.basis === b.basis && a.startTs === b.startTs && a.endTs === b.endTs;
}

export function windowOf(r: PnlRecord): PnlWindow {
  return { basis: r.basis, startTs: r.windowStartTs, endTs: r.windowEndTs };
}

/**
 * 目标窗口：把 `atMs` 向下取整到整点作为右端，往前推 24 小时作为左端。
 *
 * **一次 Top10 聚合只算一次**，十个人共用。中途跨了整点也不重新算——
 * 各自挑「最新点」正是窗口不一致的根源。
 */
export function targetWindow(atMs: number, basis: PnlBasis = 'snapshot'): PnlWindow {
  const endTs = Math.floor(atMs / HOUR_MS) * HOUR_MS;
  return { basis, startTs: endTs - DAY_MS, endTs };
}

/**
 * 序列归一化：排序、去重、查冲突、剔除无效值。
 *
 * 重复但数值相同 → 去重放行；重复且数值不同 → `conflict`，整条序列不可用
 * （不知道哪个对的时候选一个，就是编数据）。
 */
export function normalizeSeries(raw: unknown): { points: SeriesPoint[]; dropped: number; conflict: boolean } {
  if (!Array.isArray(raw)) return { points: [], dropped: 0, conflict: false };
  const byId = new Map<number, number>();
  let dropped = 0, conflict = false;
  for (const item of raw) {
    const o = item as Record<string, unknown> | null;
    const id = typeof o?.['snapshotId'] === 'number' ? o['snapshotId'] : Number(o?.['snapshotId']);
    const pnl = typeof o?.['pnl'] === 'number' ? o['pnl'] : Number(o?.['pnl']);
    if (!Number.isFinite(id) || !Number.isInteger(id) || !Number.isFinite(pnl)) { dropped++; continue; }
    const prev = byId.get(id);
    if (prev !== undefined) {
      if (prev !== pnl) conflict = true;
      continue;
    }
    byId.set(id, pnl);
  }
  const points = [...byId].map(([snapshotId, pnl]) => ({ snapshotId, pnl }))
    .sort((a, b) => a.snapshotId - b.snapshotId);
  return { points, dropped, conflict };
}

/**
 * 从序列里定出这次聚合的**锚点窗口**。
 *
 * 想要的是 `preferredEndTs` 那个整点，但整点快照有发布延迟（实测 11:18 才看到 11:00
 * 那个点是常态，反过来 11:03 可能还没有）。所以允许往前退**最多一个整点**，
 * 退不到就返回 null——宁可这一轮没有全平台收益，也不去凑一个更长或更旧的窗口。
 */
export function anchorWindow(raw: unknown, preferredEndTs: number, basis: PnlBasis = 'snapshot'): PnlWindow | null {
  const { points } = normalizeSeries(raw);
  if (!points.length) return null;
  const preferredEndSec = Math.floor(preferredEndTs / 1000);
  const earliestSec = preferredEndSec - MAX_ANCHOR_LAG_MS / 1000;
  for (let i = points.length - 1; i >= 0; i--) {
    const sec = points[i]!.snapshotId;
    if (sec > preferredEndSec) continue;
    if (sec < earliestSec) return null;
    if ((sec * 1000) % HOUR_MS !== 0) continue;          // 不在整点上的点不能当锚
    return { basis, startTs: sec * 1000 - DAY_MS, endTs: sec * 1000 };
  }
  return null;
}

/**
 * 这个窗口能不能当本次聚合的锚点：右端不晚于目标整点，且不早于目标整点一个小时。
 *
 * 跨整点时，上一小时的缓存窗口正是靠这条被挡在外面——它相对新的目标整点已经差了
 * 一个小时以上，复用它就等于把两个不同的 24 小时加在一起。
 */
export function usableAnchor(w: PnlWindow, preferredEndTs: number, basis: PnlBasis = 'snapshot'): boolean {
  return w.basis === basis && isDayWindow(w)
    && w.endTs <= preferredEndTs && preferredEndTs - w.endTs <= MAX_ANCHOR_LAG_MS;
}

/**
 * 从若干候选窗口里挑一个本批共用的锚点：先要可用，然后取**最新**的那个；
 * 同样新的取命中数多的。挑不出来就返回 null——宁可现取，也不拼一个旧窗口。
 */
export function bestAnchor(
  candidates: { window: PnlWindow; hits: number }[], preferredEndTs: number, basis: PnlBasis = 'snapshot',
): PnlWindow | null {
  let best: { window: PnlWindow; hits: number } | null = null;
  for (const c of candidates) {
    if (!usableAnchor(c.window, preferredEndTs, basis)) continue;
    if (!best || c.window.endTs > best.window.endTs
        || (c.window.endTs === best.window.endTs && c.hits > best.hits)) best = c;
  }
  return best?.window ?? null;
}

/**
 * 按**给定窗口**从序列推一条记录。窗口由调用方统一确定，这里绝不自己挑「最新点」。
 *
 * 起点必须精确命中 `windowStartTs` 对应的整点。找不到就是 `no_start_point`——
 * 用更早的点代替会把 25 小时甚至 43 小时的区间标成 24H。
 */
export function deriveRecord(
  userId: string, raw: unknown, window: PnlWindow, fetchedTs: number,
  source: PnlSource = 'aggregated_snapshot',
): { ok: true; record: PnlRecord } | { ok: false; reason: PnlMiss } {
  if (!isDayWindow(window)) return { ok: false, reason: 'bad_window' };
  const { points, conflict } = normalizeSeries(raw);
  if (conflict) return { ok: false, reason: 'conflicting_points' };
  if (!points.length) return { ok: false, reason: 'no_series' };

  const endSec = window.endTs / 1000;
  const startSec = window.startTs / 1000;
  const end = points.find(p => p.snapshotId === endSec);
  if (!end) return { ok: false, reason: 'no_end_point' };
  const start = points.find(p => p.snapshotId === startSec);
  if (!start) return { ok: false, reason: 'no_start_point' };

  const value = end.pnl - start.pnl;
  if (!Number.isFinite(value)) return { ok: false, reason: 'invalid_value' };
  return {
    ok: true,
    record: {
      userId, value, source, basis: window.basis,
      windowStartTs: window.startTs, windowEndTs: window.endTs, fetchedTs,
    },
  };
}

/** 聚合结果。缺失一定带原因和覆盖率，不会退化成 0。 */
export interface PnlAggregate {
  /** 收益总和。成员齐全、口径一致、窗口一致才有值。 */
  total: number | null;
  /** 盈利人数：这批记录里 value > 0 的个数。零收益不算盈利。 */
  profitable: number | null;
  covered: number;
  expected: number;
  window: PnlWindow | null;
  /** 这批记录的获取时间上界（最后一个人是什么时候拿到的） */
  fetchedTs: number | null;
  reason: string | null;
}

export const emptyAggregate = (expected = 0, reason: string | null = null): PnlAggregate => ({
  total: null, profitable: null, covered: 0, expected, window: null, fetchedTs: null, reason,
});

/**
 * 聚合前的四项校验：成员完整性、数值有效性、口径一致性、起止时间一致性。
 * 任何一项不满足都返回 `total = null` 和明确原因——**禁止部分求和冒充完整结果**。
 *
 * `memberIds` 是本次 Top10 的成员（没有 userId 的位置传 null，它永远不可能有记录，
 * 因此会如实计入「缺失」而不是被悄悄跳过）。
 */
export function aggregatePnl(
  memberIds: (string | null)[],
  records: ReadonlyMap<string, PnlRecord>,
  nowTs = Date.now(),
  maxWindowAgeMs = MAX_WINDOW_AGE_MS,
): PnlAggregate {
  const expected = memberIds.length;
  if (expected === 0) return emptyAggregate(0, 'Top10 集合为空');

  const rows: PnlRecord[] = [];
  let noId = 0;
  for (const id of memberIds) {
    if (!id) { noId++; continue; }
    const r = records.get(id);
    if (r) rows.push(r);
  }
  const covered = rows.length;
  // 窗口只有在这批记录**确实一致**时才报出来。不一致却报一个「代表窗口」，
  // 等于把口径冲突藏起来，卡片上就会出现一个看着有理有据的假窗口。
  const uniform = rows.length > 0 && rows.every(r =>
    r.basis === rows[0]!.basis && r.windowStartTs === rows[0]!.windowStartTs && r.windowEndTs === rows[0]!.windowEndTs);
  const base = (reason: string): PnlAggregate => ({
    total: null, profitable: null, covered, expected,
    window: uniform ? windowOf(rows[0]!) : null,
    fetchedTs: rows.length ? Math.max(...rows.map(r => r.fetchedTs)) : null,
    reason,
  });

  if (covered < expected) {
    return base(noId ? `缺 ${expected - covered} 人（其中 ${noId} 人无 userId）` : `缺 ${expected - covered} 人的收益记录`);
  }
  if (rows.some(r => !Number.isFinite(r.value))) return base('存在非有限收益数值');

  const first = windowOf(rows[0]!);
  if (!isDayWindow(first)) return base('窗口长度不是 24 小时');
  if (rows.some(r => r.basis !== first.basis)) return base('口径不一致（实时与整点混用）');
  if (rows.some(r => r.windowStartTs !== first.startTs || r.windowEndTs !== first.endTs)) {
    return base('窗口起止时间不一致');
  }
  if (nowTs - first.endTs > maxWindowAgeMs) return base('窗口已过期');

  return {
    total: rows.reduce((a, r) => a + r.value, 0),
    profitable: rows.filter(r => r.value > 0).length,
    covered, expected, window: first,
    fetchedTs: Math.max(...rows.map(r => r.fetchedTs)),
    reason: null,
  };
}
