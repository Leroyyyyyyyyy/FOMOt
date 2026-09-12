/**
 * post 模式专用的 Telegram 出口（设计文档 §11.3）。
 *
 * 与现有 `telegram.ts` 的关键区别：**单次调用、结构化结果、不盲重试**。
 *
 * 现有 Sender 会对网络失败连着重试 4 次，而且分不清「服务端已收但返回丢了」
 * 和「确实没发出去」。外面再包一层 outbox 也没用——底层已经把重复发送做掉了。
 * 所以这里只发一次，把三种结果如实告诉调用方，由 outbox 决定怎么处置：
 *
 *   delivered        明确成功，带 messageId
 *   definiteFailure  明确没成功（HTTP 有明确响应），带 retryable / retryAfter
 *   ambiguous        不知道成没成（超时、连接中断）——**绝不自动重发新建主卡**
 */
import { env } from '../config.js';
import { log } from '../logger.js';

export type SendOutcome =
  | { kind: 'delivered'; messageId: number }
  | { kind: 'definiteFailure'; retryable: boolean; retryAfterMs: number | null; code: number | null; description: string }
  | { kind: 'ambiguous'; description: string };

/** 错误日志里绝不能出现 bot token。 */
const redact = (s: string): string => s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');

interface TgResponse<T> {
  ok: boolean; result?: T; description?: string; error_code?: number;
  parameters?: { retry_after?: number };
}

async function call<T>(method: string, body: unknown, timeoutMs: number): Promise<
  { kind: 'ok'; result: T } | Exclude<SendOutcome, { kind: 'delivered' }>
> {
  // 兜底闸门：禁发送模式下任何代码路径都不允许产生 Telegram 网络请求。
  if ((process.env.NOTIFY_MODE ?? 'off').toLowerCase() !== 'telegram') {
    throw new Error(`禁发送模式下不允许调用 Telegram ${method}`);
  }
  const { token } = env.requireTelegram();
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // 超时/连接中断：服务端可能已经收下了。这是 ambiguous，不是失败。
    return { kind: 'ambiguous', description: redact(String(err)).slice(0, 200) };
  }

  let j: TgResponse<T>;
  try { j = (await res.json()) as TgResponse<T>; }
  catch (err) {
    // 有 HTTP 响应但读不出来，同样无法断定服务端状态。
    return { kind: 'ambiguous', description: `HTTP ${res.status} 响应无法解析: ${redact(String(err)).slice(0, 120)}` };
  }

  if (j.ok) return { kind: 'ok', result: j.result as T };

  const code = j.error_code ?? res.status;
  const description = redact(j.description ?? `HTTP ${res.status}`);
  if (code === 429) {
    return { kind: 'definiteFailure', retryable: true, retryAfterMs: (j.parameters?.retry_after ?? 5) * 1000, code, description };
  }
  if (code === 403) {
    // 权限问题：进 failed 并输出本地健康告警，不持续轰炸。
    log.error({ method, description }, 'Telegram 拒绝（403），进入 failed 并需要人工处理');
    return { kind: 'definiteFailure', retryable: false, retryAfterMs: null, code, description };
  }
  if (code >= 500) {
    return { kind: 'definiteFailure', retryable: true, retryAfterMs: null, code, description };
  }
  // 400 等确定性错误：文案有问题，重试多少次都一样。
  return { kind: 'definiteFailure', retryable: false, retryAfterMs: null, code, description };
}

export async function sendOnce(text: string, replyMarkup: unknown, timeoutMs = 15_000): Promise<SendOutcome> {
  const { chatId } = env.requireTelegram();
  const r = await call<{ message_id: number }>('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: replyMarkup,
  }, timeoutMs);
  if (r.kind !== 'ok') return r;
  return { kind: 'delivered', messageId: r.result.message_id };
}

export async function editOnce(messageId: number, text: string, replyMarkup: unknown, timeoutMs = 15_000): Promise<SendOutcome> {
  const { chatId } = env.requireTelegram();
  const r = await call<{ message_id: number }>('editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: replyMarkup,
  }, timeoutMs);
  if (r.kind === 'ok') return { kind: 'delivered', messageId: r.result.message_id ?? messageId };
  // 「消息内容没变化」说明目标内容已经达到，算成功。
  if (r.kind === 'definiteFailure' && /message is not modified/i.test(r.description)) {
    return { kind: 'delivered', messageId };
  }
  return r;
}

/** 已知 messageId 的编辑失败里，哪些属于「这条消息没法再编辑了」。 */
export const isUneditable = (o: SendOutcome): boolean =>
  o.kind === 'definiteFailure' && !o.retryable &&
  /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(o.description);
