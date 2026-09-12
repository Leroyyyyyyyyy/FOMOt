/**
 * DeBot 外部候选 adapter —— **stub，默认关闭**（设计文档 §9.3）。
 *
 * 阶段 0 的结论是 unknown：只查到功能教程，没有核验到可直接复用的开发者
 * API / WebSocket 契约。**这不等于确认 DeBot 没有 API**，只是我们还没验过。
 *
 * 启用前必须先做独立只读取数 spike，验明：访问方式、用户已有权限、
 * Robinhood 链覆盖、CA 字段、事件时间、重复标识、速率与失败响应。
 * 在那之前不从截图猜 URL，也不把自研规则标成「DeBot AI」。
 *
 * 降级顺序（§9.3）：官方授权接口（若验证可用）→ 用户提供的导出/公开信号文件
 * （走 scripts/post-import.ts）→ 纯链上发现 + 人工 CA。
 */
import type { ExternalCandidate, ExternalCandidateProvider } from './types.js';

export class DebotProviderStub implements ExternalCandidateProvider {
  readonly id = 'debot';
  readonly available = false;
  readonly unavailableReason =
    'DeBot adapter 未启用：尚未核验到可复用的开发者接口契约。' +
    '请先做只读取数 spike 并更新 docs/run/POST_DEPENDENCIES.md，再把 external_candidates.debot_enabled 改成 true。';

  async poll(): Promise<ExternalCandidate[]> {
    // 不可用时返回空数组而不是抛错：DeBot unavailable 不得阻塞纯链上候选。
    return [];
  }
}

/**
 * 从用户提供的导出文件导入外部信号时的字段白名单。
 * 只接受可证明的字段；「3 个聪明钱包」这类必须带来源，
 * 不能用 `Swap.sender` 冒充真实用户，也不用旧 FOMO 持币数代理。
 */
export function normalizeExternalCandidate(raw: unknown, observedAt: number): { errors: string[]; candidate?: ExternalCandidate } {
  const errors: string[] = [];
  const r = raw as any;
  if (!r || typeof r !== 'object') return { errors: ['条目必须是对象'] };
  if (!Number.isInteger(r.chainId)) errors.push('chainId 必须是整数');
  if (typeof r.ca !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.ca)) errors.push('ca 必须是 0x 开头的 40 位十六进制地址');
  if (r.signal !== 'buy' && r.signal !== 'sell') errors.push("signal 必须是 'buy' 或 'sell'");
  if (typeof r.sourceEventId !== 'string' || !r.sourceEventId) errors.push('sourceEventId 必须是非空字符串（去重依据）');
  if (r.eventTs != null && typeof r.eventTs !== 'number') errors.push('eventTs 必须是数字或 null');
  if (r.wallets != null && !Number.isInteger(r.wallets)) errors.push('wallets 必须是整数或 null');
  if (typeof r.evidenceRef !== 'string' || !r.evidenceRef) {
    errors.push('evidenceRef 必须说明这条信号的来源（导出文件名/截图编号/页面）；没有来源的字段不导入');
  }
  if (errors.length) return { errors };
  return {
    errors: [],
    candidate: {
      chainId: r.chainId, ca: String(r.ca).toLowerCase(), signal: r.signal,
      sourceEventId: r.sourceEventId,
      eventTs: r.eventTs ?? null,
      observedAt,
      // 迟到的事件按 observedAt 生效，不能倒填成事发时间去骗过无前视检查。
      availableAt: observedAt,
      wallets: r.wallets ?? null,
      evidenceRef: r.evidenceRef,
      raw,
    },
  };
}
