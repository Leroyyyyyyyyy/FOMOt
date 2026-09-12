/**
 * 人工结构化导入 provider（设计文档 §9.1 的「必须交付的叙事最小闭环」）。
 *
 * 没有付费搜索/LLM 账号时，主链路也必须能完整跑通。这个 provider 只读
 * 已经通过 `scripts/post-import.ts` 校验并落库的报告，不发任何网络请求。
 */
import { latestReport, type NarrativeReport } from '../narrative.js';
import type { NarrativeProviderApi, NarrativeRequest } from './types.js';

export class ManualNarrativeProvider implements NarrativeProviderApi {
  readonly id = 'manual';
  readonly kind = 'manual' as const;
  readonly available = true;

  async fetch(req: NarrativeRequest): Promise<NarrativeReport | null> {
    return latestReport(req.chainId, req.ca, req.asOf);
  }
}

/**
 * 自动 provider 的占位。**故意不实现**：阶段 0 核验结果是 unknown——
 * 没有可用的搜索/社媒数据源与费用预算，不能假定「LLM 只拿到 CA 就知道真实叙事」。
 * 接入前必须先列出可用数据源、费用限制与速率，再单独验收（阶段 4）。
 */
export class UnconfiguredAutoNarrativeProvider implements NarrativeProviderApi {
  readonly id = 'configured_auto';
  readonly kind = 'configured_auto' as const;
  readonly available = false;
  readonly unavailableReason =
    '自动叙事 provider 未接入：阶段 0 没有核验到可用的搜索/社媒数据源与模型端点预算。' +
    '接入前请先补 docs/run/POST_DEPENDENCIES.md 的对应条目，再把 narrative.provider 改成 configured_auto。';

  async fetch(): Promise<NarrativeReport | null> {
    return null;                 // 没有结论 ≠ reject，也 ≠ pass
  }
}

export function narrativeProvider(kind: 'manual' | 'configured_auto'): NarrativeProviderApi {
  return kind === 'manual' ? new ManualNarrativeProvider() : new UnconfiguredAutoNarrativeProvider();
}
