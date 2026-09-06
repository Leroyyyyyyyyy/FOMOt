import { appendFileSync } from 'node:fs';
import { env } from '../config.js';
import { log } from '../logger.js';
import { telegram } from './telegram.js';
import { db, dbFile } from '../db.js';

/**
 * 通知出口。
 *
 * `off` 是**显式的禁发送模式**：不做任何 Telegram 网络调用，
 * 初始发送、复核改写、复核撤回三条路径全部只进本地记录器。
 * 以前只靠「没配 token 就不发」是不够的——恢复出来的任务带着旧 message_id，
 * 撤回/改写路径照样会去调 requireTelegram() 然后抛错。
 */
export type NotifyMode = 'off' | 'telegram';

export interface SendResult { messageId: number; delivered: boolean }

/** 跟数据库放在一起：测试用临时库时，记录也落在临时目录，不污染日常运行数据。 */
const logPath = dbFile === ':memory:'
  ? null
  : `${dbFile.replace(/\.db$/, '')}.notifications.jsonl`;

const insertLog = db.prepare(
  `INSERT INTO notification_log (ts, mode, op, message_id, ca, trigger_ts, ok, detail)
   VALUES (?,?,?,?,?,?,?,?)`,
);

export interface NotifyRef { ca: string; triggerTs: number }

function record(mode: NotifyMode, op: 'send' | 'edit' | 'remove', messageId: number | null,
                ref: NotifyRef | null, ok: boolean, detail: string): void {
  const ts = Date.now();
  try { insertLog.run(ts, mode, op, messageId, ref?.ca ?? null, ref?.triggerTs ?? null, ok ? 1 : 0, detail.slice(0, 500)); }
  catch (err) { log.warn({ err: String(err).slice(0, 120) }, '通知记录入库失败'); }
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify({ ts, mode, op, messageId, ...ref, ok, detail }) + '\n');
  } catch { /* 记录器本身不能拖垮主流程 */ }
}

/**
 * 禁发送模式下的 message_id。必须是**稳定且唯一**的正整数，
 * 好让「发送 → 落库 → 复核改写」这条状态机跟真实模式走同一条代码路径。
 */
let localSeq = 0;
function localMessageId(): number { return Date.now() % 1_000_000_000 * 100 + (++localSeq % 100); }

export class Notifier {
  constructor(readonly mode: NotifyMode) {}

  get canSend(): boolean { return this.mode === 'telegram' }

  async send(text: string, markup: unknown, ref: NotifyRef): Promise<SendResult | null> {
    if (!this.canSend) {
      const messageId = localMessageId();
      record('off', 'send', messageId, ref, true, text);
      log.info({ ca: ref.ca, messageId }, '[禁发送] 初始卡片');
      log.info('\n' + stripHtml(text) + '\n');
      return { messageId, delivered: false };
    }
    const sent = await telegram.send(text, markup);
    record('telegram', 'send', sent?.message_id ?? null, ref, !!sent, sent ? text : 'send 失败');
    return sent ? { messageId: sent.message_id, delivered: true } : null;
  }

  async edit(messageId: number, text: string, markup: unknown, ref: NotifyRef): Promise<boolean> {
    if (!this.canSend) {
      record('off', 'edit', messageId, ref, true, text);
      log.info({ ca: ref.ca, messageId }, '[禁发送] 复核改写');
      log.info('\n[复核]\n' + stripHtml(text) + '\n');
      return true;
    }
    const ok = (await telegram.edit(messageId, text, markup)) !== null;
    record('telegram', 'edit', messageId, ref, ok, ok ? text : 'edit 失败');
    return ok;
  }

  async remove(messageId: number, ref: NotifyRef): Promise<boolean> {
    if (!this.canSend) {
      record('off', 'remove', messageId, ref, true, '复核门未通过');
      log.info({ ca: ref.ca, messageId }, '[禁发送] 复核撤回');
      return true;
    }
    const ok = (await telegram.remove(messageId)) !== null;
    record('telegram', 'remove', messageId, ref, ok, ok ? 'ok' : 'remove 失败');
    return ok;
  }
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '');

/**
 * 默认关闭。只有显式 `NOTIFY_MODE=telegram` **且**凭据齐全才会真的发网络请求；
 * 任何一项不满足都退回 off，并且把原因说清楚。
 */
export function resolveMode(): NotifyMode {
  const want = (process.env.NOTIFY_MODE ?? 'off').toLowerCase();
  if (want !== 'telegram') return 'off';
  if (!env.telegramEnabled) {
    log.warn('NOTIFY_MODE=telegram 但缺少 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，退回禁发送模式');
    return 'off';
  }
  return 'telegram';
}

export const notifier = new Notifier(resolveMode());
