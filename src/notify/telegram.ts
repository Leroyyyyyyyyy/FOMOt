import { env } from '../config.js';
import { log } from '../logger.js';

interface TgResponse<T> { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }

/**
 * Telegram 对同一个群/频道的限速大约是 20 条/分钟，超了返回 429 带 retry_after。
 * 这里用一条串行队列 + 最小间隔，撞 429 就按它给的秒数退避重发。
 */
class Sender {
  private queue: Promise<unknown> = Promise.resolve();
  private lastSent = 0;
  private readonly minGapMs = 3200;

  private async call<T>(method: string, body: unknown): Promise<T | null> {
    /**
     * 兜底闸门。正常路径上 Notifier 已经拦住了，但这里再挡一次：
     * 任何新代码（包括恢复出来的复核任务）都不可能在禁发送模式下发出网络请求。
     */
    if ((process.env.NOTIFY_MODE ?? 'off').toLowerCase() !== 'telegram') {
      throw new Error(`禁发送模式下不允许调用 Telegram ${method}`);
    }
    const { token } = env.requireTelegram();
    for (let attempt = 0; attempt < 4; attempt++) {
      const gap = this.minGapMs - (Date.now() - this.lastSent);
      if (gap > 0) await new Promise(r => setTimeout(r, gap));
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        this.lastSent = Date.now();
        const j = (await res.json()) as TgResponse<T>;
        if (j.ok) return j.result ?? null;
        if (res.status === 429) {
          const wait = (j.parameters?.retry_after ?? 5) * 1000;
          log.warn({ method, wait }, 'Telegram 限速，退避');
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        log.error({ method, desc: j.description }, 'Telegram 接口报错');
        return null;
      } catch (err) {
        log.warn({ method, err: String(err).slice(0, 120) }, 'Telegram 请求失败，重试');
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    return null;
  }

  /** 串行化，保证限速间隔真的生效 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  send(text: string, replyMarkup?: unknown): Promise<{ message_id: number } | null> {
    const { chatId } = env.requireTelegram();
    return this.enqueue(() => this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    }));
  }

  /** 复核阶段 FOMO 门没过时撤回已发出的卡片 */
  remove(messageId: number): Promise<unknown> {
    const { chatId } = env.requireTelegram();
    return this.enqueue(() => this.call('deleteMessage', { chat_id: chatId, message_id: messageId }));
  }

  /** 复核阶段改写原消息——原版卡片右下角那个 "edited" 就是这么来的 */
  edit(messageId: number, text: string, replyMarkup?: unknown): Promise<unknown> {
    const { chatId } = env.requireTelegram();
    return this.enqueue(() => this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    }));
  }
}

export const telegram = new Sender();
