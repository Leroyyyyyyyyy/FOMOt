/**
 * 外部 provider 契约（设计文档 §9）。
 *
 * 这里只定义接口。首版**只实现 manual provider**——没有付费搜索/LLM 账号时，
 * 人工结构化导入也必须能把主链路跑通。自动 provider 与 DeBot 是可选加速，
 * 未做独立取数核验前不得启用，更不能从截图猜 URL。
 */
import type { NarrativeReport } from '../narrative.js';

export interface NarrativeRequest {
  chainId: number;
  ca: string;
  symbol?: string | null;
  name?: string | null;
  /** 形态首次被发现的时间。provider 的结论必须带 availableAt，不能倒填到这个时点。 */
  patternDetectedAt: number;
  asOf: number;
}

export interface NarrativeProviderApi {
  readonly id: string;
  readonly kind: 'manual' | 'configured_auto';
  /** 返回 null 表示本 provider 没有结论（不是 reject，也不是 pass）。 */
  fetch(req: NarrativeRequest): Promise<NarrativeReport | null>;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

/** 外部候选（DeBot 等）。只导入可证明的字段，缺的保留 null。 */
export interface ExternalCandidate {
  chainId: number;
  ca: string;
  signal: 'buy' | 'sell';
  sourceEventId: string;
  eventTs: number | null;
  observedAt: number;
  /** 系统真正可以使用它的时间；迟到的事件不能倒填成事发时间。 */
  availableAt: number;
  wallets: number | null;
  evidenceRef: string | null;
  raw: unknown;
}

export interface ExternalCandidateProvider {
  readonly id: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  poll(since: number): Promise<ExternalCandidate[]>;
}

/** 行情 provider：首版只有链上适配器，为其它链预留。 */
export interface MarketProvider {
  readonly chainId: number;
  readonly id: string;
  readonly available: boolean;
}
