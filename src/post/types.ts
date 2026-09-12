/**
 * post_v1 的公共数据契约（设计文档 §5.1）。
 *
 * TS 类型只是文档；真正的保护来自各模块里的运行时校验。
 */

/** 数据质量。unknown ≠ pass——策略里任何地方都不能把 unknown 当通过。 */
export type Quality = 'complete' | 'partial' | 'stale' | 'unknown';

/**
 * 报价质量。
 * historical = 事件时点之前的真实报价；live = 当下报价；
 * peg_proxy = USDG=$1 这类固定锚定假设；missing = 没有合规报价，不得定价。
 */
export type QuoteQuality = 'historical' | 'live' | 'peg_proxy' | 'missing';

export type Timeframe = 60 | 300 | 900 | 3600;
export const TIMEFRAMES: Timeframe[] = [60, 300, 900, 3600];

export interface Candle {
  chainId: number; ca: string; poolId: string; seriesId: string;
  timeframeSec: Timeframe;
  openTs: number; closeTs: number; availableAt: number;
  open: number; high: number; low: number; close: number;   // USD 价
  volumeUsd: number | null; swaps: number;
  volumeAllPoolsUsd?: number | null;
  fdvCloseUsd: number | null;
  closed: boolean; synthetic: boolean; quality: Quality;
  source: string; quoteQuality: QuoteQuality;
  revision: number;
}

export interface DiscoveryEvent {
  chainId: number; ca: string; poolId?: string;
  source: 'chain' | 'debot' | 'manual'; sourceEventId: string;
  eventTs: number | null; observedAt: number; availableAt: number;
  evidenceRef?: string;
  payload?: unknown;
}

/** 逐条规则的判定。unknown 必须有独立的 reason，不能和 fail 混为一谈。 */
export interface Evaluation {
  rule: string;
  result: 'pass' | 'fail' | 'unknown';
  observed: unknown;
  threshold: unknown;
  reason: string;
  asOf: number;
  evidenceRefs: string[];
}

export const pass = (rule: string, observed: unknown, threshold: unknown, reason: string, asOf: number, refs: string[] = []): Evaluation =>
  ({ rule, result: 'pass', observed, threshold, reason, asOf, evidenceRefs: refs });
export const fail = (rule: string, observed: unknown, threshold: unknown, reason: string, asOf: number, refs: string[] = []): Evaluation =>
  ({ rule, result: 'fail', observed, threshold, reason, asOf, evidenceRefs: refs });
export const unknown = (rule: string, observed: unknown, threshold: unknown, reason: string, asOf: number, refs: string[] = []): Evaluation =>
  ({ rule, result: 'unknown', observed, threshold, reason, asOf, evidenceRefs: refs });

/** 全部 pass 才算通过；只要有一个 unknown 就不能当成通过。 */
export function gate(evals: Evaluation[]): 'pass' | 'fail' | 'unknown' {
  if (evals.some(e => e.result === 'fail')) return 'fail';
  if (evals.some(e => e.result === 'unknown')) return 'unknown';
  return 'pass';
}

/** 一条原始 Swap 事件的规范化形态。大整数用 bigint，落库时转 TEXT。 */
export interface SwapEvent {
  chainId: number;
  poolId: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  eventTs: number;            // 真实区块时间
  observedAt: number;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity?: bigint | null;
  tick?: number | null;
}

/** 链上排序的唯一依据：同秒事件按 (block, txIndex, logIndex)。 */
export function compareChainOrder(a: SwapEvent, b: SwapEvent): number {
  return a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex;
}

export interface PoolMeta {
  chainId: number; poolId: string; ca: string;
  quote: string; quoteSymbol: string; quoteDecimals: number;
  tokenIs0: boolean; tokenDecimals: number;
}

export type EpisodeStrategy = 'second_leg' | 'new_pullback' | 'million_reclaim';

export type SignalEventType =
  | 'SECOND_LEG_READY' | 'SECOND_LEG_BREAKOUT' | 'SECOND_LEG_INVALIDATED'
  | 'SECOND_LEG_EXPIRED' | 'BREAKOUT_FAILED'
  | 'NEW_PULLBACK_CONFIRMED' | 'THIRD_DIP_RISK' | 'STRUCTURE_INVALIDATED'
  | 'MILLION_RECLAIM_CONFIRMED' | 'MILLION_RECLAIM_INVALIDATED'
  | 'RSI_OVERHEAT' | 'SPECULATIVE_WATCH' | 'NARRATIVE_REVISED' | 'DATA_CORRECTED';

/** §11.1 的优先级表。P0 优先但不得永久饿死 P1。 */
export const SIGNAL_PRIORITY: Record<SignalEventType, 'P0' | 'P1' | 'P2'> = {
  SECOND_LEG_READY: 'P1',
  SECOND_LEG_BREAKOUT: 'P1',
  SECOND_LEG_INVALIDATED: 'P0',
  SECOND_LEG_EXPIRED: 'P0',
  BREAKOUT_FAILED: 'P0',
  NEW_PULLBACK_CONFIRMED: 'P1',
  THIRD_DIP_RISK: 'P0',
  STRUCTURE_INVALIDATED: 'P0',
  MILLION_RECLAIM_CONFIRMED: 'P1',
  MILLION_RECLAIM_INVALIDATED: 'P0',
  RSI_OVERHEAT: 'P0',
  SPECULATIVE_WATCH: 'P2',
  NARRATIVE_REVISED: 'P0',
  DATA_CORRECTED: 'P1',
};
