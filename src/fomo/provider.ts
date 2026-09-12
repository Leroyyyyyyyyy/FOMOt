import type { PnlMiss, PnlRecord, PnlWindow } from '../engine/pnl.js';

/**
 * 一次 Top10 全平台 24H 取数的结果。
 *
 * `window` 是这一批**共同**的目标窗口——十个人用同一组起止时间，不是各自挑最新点。
 * 拿不到的人进 `misses` 并带原因，绝不用别的量顶替，也绝不悄悄少算一个人。
 */
export interface PlatformPnlResult {
  window: PnlWindow | null;
  records: Map<string, PnlRecord>;
  misses: Map<string, PnlMiss>;
  /** 本次取数耗时（含排队），用于分阶段指标 */
  elapsedMs: number;
  /** 命中缓存的人数 */
  cacheHits: number;
}

export interface FomoLeader {
  rank: number; userId: string | null; handle: string | null;
  evmAddress: string | null; followers: number | null; pnl24h: number; updatedTs: number;
}

export interface FomoTopHolder {
  rank: number; userId: string | null; handle: string | null;
  evmAddress: string | null; followers: number | null;
  amount: number | null; pnl: number | null; isDev: boolean;
}

export interface FomoTokenStats {
  /** 持有该币的 FOMO 用户数——卡片上「全链 491 · Fomo 336」里的 Fomo */
  fomoHolders: number | null;
  top: FomoTopHolder[];
  freshMs: number;
  /** FOMO 响应落库的时间 */
  takenTs: number;
  ingestMs: number;
}

/**
 * FOMO 社交层的抽象。链上部分不依赖它——拿不到数据时全部返回空，
 * 卡片对应字段显示 n/a，规则里带 fomo_ 前缀的条件按 skip_when_unavailable 跳过。
 */
export interface FomoProvider {
  readonly ready: boolean;
  /** 触发热路径只做本地判断；页面数据未预热好时先跳过这一轮。 */
  tokenStatsWarm(ca: string, maxAgeMs?: number): boolean;
  /** 24H 盈利榜（名次靠数组顺序，接口本身没有 rank 字段） */
  leaderboard24h(): Promise<FomoLeader[]>;
  /**
   * 某个币的 FOMO 侧持币情况；会去逛一次它的代币页。
   * maxAgeMs 控制缓存新鲜度——复核阶段要传小值强制刷新，否则拿回来的还是初值那份。
   * FOMO 自己的持币索引对新币有延迟（实测某币触发时是 0，21 秒后才变成 2），
   * 复核这一步的意义就在这里。
   */
  tokenStats(ca: string, maxAgeMs?: number, priority?: 'recheck' | 'alert' | 'prewarm'): Promise<FomoTokenStats | null>;
  /**
   * 任意用户的**全平台 24H 收益**（`aggregatedSnapshot` 序列的 24 小时差）。
   * 这跟 `/hodlers/top.pnl`（该币累计收益）是两个量，见 docs/FIELDS.md §2。
   * 可选：取不到就不实现，卡片对应字段显示 n/a，绝不用该币收益顶替。
   *
   * `preferredEndTs` 是调用方**统一确定**的目标窗口右端（整点）。实现可以因为
   * 整点快照发布延迟往前退最多一个整点，但退过之后这一批十个人必须共用同一个窗口。
   */
  platformPnl24h?(userIds: string[], preferredEndTs: number): Promise<PlatformPnlResult>;
  /** 「浏览器→入库」延迟，直接进健康行 */
  ingestLatencyMs(): number;
  /** 退出时关掉浏览器，避免 profile 里留下 SingletonLock 让下次启动打不开 */
  close?(): Promise<void>;
}

export const nullFomo: FomoProvider = {
  ready: false,
  tokenStatsWarm() { return false; },
  async leaderboard24h() { return []; },
  async tokenStats(_ca?: string, _maxAgeMs?: number, _priority?: 'recheck' | 'alert' | 'prewarm') { return null; },
  ingestLatencyMs() { return 0; },
};
