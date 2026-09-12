/**
 * 持久 outbox 与恢复（设计文档 §11.3）。
 *
 * 关于「恰好一次」的诚实说明：Telegram 的 sendMessage **没有本项目可依赖的
 * 客户端幂等键**，所以端到端恰好一次做不到，也不承诺。这里做的是：
 *   - 数据确认与 outbox 入库原子提交，进程在网络之前死掉可以安全重排；
 *   - 发送前 lease + 检查 deadline + 检查有没有被更高 revision 的失效事件替代；
 *   - 结果分三类，`unknown` 的**新建主卡默认不自动重发**，进人工核对清单
 *     （因此可能漏通知，报告必须把这个数量计出来）；
 *   - 已知 messageId 的 edit 可以重试，`message is not modified` 视为达到目标。
 *
 * off 与 telegram 两种模式的 message 引用严格隔离：off→telegram 不把演练当已送达，
 * telegram→off 也不会去动真实消息。
 */
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import './store.js';
import { log } from '../logger.js';
import { sendOnce, editOnce, isUneditable, type SendOutcome } from '../notify/post-telegram.js';
import type { NotifyMode } from '../notify/notifier.js';

export type OutboxState = 'pending' | 'sending' | 'sent' | 'unknown' | 'failed' | 'expired';
export type OutboxOp = 'send' | 'edit';

export interface OutboxTask {
  outboxId: string;
  signalId: string;
  groupId: string;
  op: OutboxOp;
  revision: number;
  destination: string;
  mode: NotifyMode;
  state: OutboxState;
  attempt: number;
  leaseUntil: number | null;
  dueAt: number;
  deadlineAt: number;
  payload: { text: string; markup?: unknown; priority: 'P0' | 'P1' | 'P2' };
  messageId: number | null;
  lastError: string | null;
  runId: string;
}

export interface EnqueueInput {
  signalId: string;
  groupId: string;
  op: OutboxOp;
  revision?: number;
  destination: string;
  mode: NotifyMode;
  dueAt: number;
  deadlineAt: number;
  payload: OutboxTask['payload'];
  messageId?: number | null;
  runId?: string;
}

export const outboxId = (i: EnqueueInput): string =>
  `O-${createHash('sha256')
    .update([i.signalId, i.op, i.revision ?? 1, i.destination, i.mode, i.runId ?? 'live'].join('|'))
    .digest('hex').slice(0, 16)}`;

const insert = db.prepare(
  `INSERT INTO post_outbox (outbox_id, signal_id, group_id, op, revision, destination, mode, state,
     attempt, lease_until, due_at, deadline_at, payload, message_id, created_at, updated_at, run_id)
   VALUES (?,?,?,?,?,?,?, 'pending', 0, NULL, ?,?,?,?,?,?,?)
   ON CONFLICT(signal_id, op, revision, destination, mode, run_id) DO NOTHING`,
);

/**
 * 入队。**必须在调用方的事务里调用**，与信号落库一起提交（§10）。
 * 幂等：同一 (signal, op, revision, destination, mode, run) 重放不会产生第二条任务。
 */
export function enqueue(i: EnqueueInput, now: number): string {
  const id = outboxId(i);
  insert.run(id, i.signalId, i.groupId, i.op, i.revision ?? 1, i.destination, i.mode,
    i.dueAt, i.deadlineAt, JSON.stringify(i.payload), i.messageId ?? null, now, now, i.runId ?? 'live');
  return id;
}

function toTask(r: any): OutboxTask {
  return {
    outboxId: r.outbox_id, signalId: r.signal_id, groupId: r.group_id, op: r.op, revision: r.revision,
    destination: r.destination, mode: r.mode, state: r.state, attempt: r.attempt,
    leaseUntil: r.lease_until, dueAt: r.due_at, deadlineAt: r.deadline_at,
    payload: JSON.parse(r.payload), messageId: r.message_id, lastError: r.last_error, runId: r.run_id,
  };
}

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2 } as const;

/**
 * 领取一个任务。
 *
 * 排序：P0 优先，但**不能永久饿死 P1**——等待超过 starvationMs 的任务按到期时间提前。
 * lease 期间其它 worker 看不到它；lease 超时的 `sending` 一律按「可能已发」处理
 * （见 reapStaleLeases），不直接当 pending。
 */
export function lease(mode: NotifyMode, now: number, leaseMs = 30_000, runId = 'live', starvationMs = 60_000): OutboxTask | null {
  const rows = db.prepare(
    `SELECT * FROM post_outbox
     WHERE mode=? AND run_id=? AND state='pending' AND due_at <= ?
     ORDER BY due_at LIMIT 50`,
  ).all(mode, runId, now) as any[];
  if (!rows.length) return null;

  const tasks = rows.map(toTask).sort((a, b) => {
    const aStarved = now - a.dueAt > starvationMs, bStarved = now - b.dueAt > starvationMs;
    if (aStarved !== bStarved) return aStarved ? -1 : 1;       // 等太久的先走，防饿死
    const p = PRIORITY_ORDER[a.payload.priority] - PRIORITY_ORDER[b.payload.priority];
    return p !== 0 ? p : a.dueAt - b.dueAt;
  });

  for (const t of tasks) {
    // 过期任务不再发成实时信号，直接归档（§11.3）。
    if (now > t.deadlineAt) { markExpired(t.outboxId, now, '领取时已过期限'); continue; }
    // 被更高 revision 的失效事件替代的任务不再发。
    if (supersededBy(t, runId)) { markExpired(t.outboxId, now, '已被更高 revision 的事件替代'); continue; }
    const r = db.prepare(
      `UPDATE post_outbox SET state='sending', lease_until=?, attempt=attempt+1, updated_at=?
       WHERE outbox_id=? AND state='pending'`,
    ).run(now + leaseMs, now, t.outboxId);
    if (Number(r.changes) === 1) return { ...t, state: 'sending', attempt: t.attempt + 1, leaseUntil: now + leaseMs };
  }
  return null;
}

function supersededBy(t: OutboxTask, runId: string): boolean {
  const r = db.prepare(
    `SELECT COUNT(*) n FROM post_outbox WHERE group_id=? AND run_id=? AND revision > ? AND op=? AND state IN ('sent','pending','sending')`,
  ).get(t.groupId, runId, t.revision, t.op) as any;
  return r.n > 0;
}

export function markExpired(id: string, now: number, reason: string): void {
  db.prepare(`UPDATE post_outbox SET state='expired', last_error=?, updated_at=? WHERE outbox_id=?`)
    .run(reason.slice(0, 300), now, id);
}

/**
 * lease 超时回收。**一律按「可能已发」处理**，转 unknown 而不是 pending——
 * 进程死在 HTTP 往返中间时，服务端可能已经收下了。
 */
export function reapStaleLeases(now: number, runId = 'live'): number {
  const r = db.prepare(
    `UPDATE post_outbox SET state='unknown', last_error='lease 超时，无法确认是否已送达', updated_at=?
     WHERE run_id=? AND state='sending' AND lease_until IS NOT NULL AND lease_until < ?`,
  ).run(now, runId, now);
  return Number(r.changes);
}

const upsertRef = db.prepare(
  `INSERT INTO post_message_refs (group_id, destination, mode, chat_id, message_id, delivered, last_revision, first_sent_at, updated_at, run_id)
   VALUES (?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(group_id, destination, mode, run_id) DO UPDATE SET
     message_id=excluded.message_id, delivered=excluded.delivered,
     last_revision=MAX(post_message_refs.last_revision, excluded.last_revision),
     updated_at=excluded.updated_at`,
);

export function messageRef(groupId: string, destination: string, mode: NotifyMode, runId = 'live'):
  { messageId: number | null; delivered: boolean; lastRevision: number } | null {
  const r = db.prepare('SELECT * FROM post_message_refs WHERE group_id=? AND destination=? AND mode=? AND run_id=?')
    .get(groupId, destination, mode, runId) as any;
  return r ? { messageId: r.message_id, delivered: !!r.delivered, lastRevision: r.last_revision } : null;
}

export interface SendPort {
  send(text: string, markup: unknown): Promise<SendOutcome>;
  edit(messageId: number, text: string, markup: unknown): Promise<SendOutcome>;
}

/** 真实 Telegram 出口。只在 mode==='telegram' 时使用。 */
export const telegramPort: SendPort = {
  send: (text, markup) => sendOnce(text, markup),
  edit: (id, text, markup) => editOnce(id, text, markup),
};

/**
 * 禁发送模式的本地出口。**不产生任何网络调用**，但走同一条状态机，
 * 这样「发送 → 落库 → 修改 → 失效」在演练里也被真正跑过。
 */
export function offPort(): SendPort {
  let seq = 0;
  return {
    async send(text) {
      const messageId = (Date.now() % 1_000_000_000) * 100 + (++seq % 100);
      log.info({ messageId }, '[禁发送] post 卡片');
      log.info('\n' + text.replace(/<[^>]+>/g, '') + '\n');
      return { kind: 'delivered', messageId };
    },
    async edit(messageId, text) {
      log.info({ messageId }, '[禁发送] post 卡片改写');
      log.info('\n[改写]\n' + text.replace(/<[^>]+>/g, '') + '\n');
      return { kind: 'delivered', messageId };
    },
  };
}

export interface DispatchResult {
  outboxId: string;
  state: OutboxState;
  messageId: number | null;
  detail: string;
}

export interface DispatchOptions {
  /** unknown 的新建主卡是否允许自动重发。默认 manual_reconcile：不重发。 */
  ambiguousPolicy?: 'manual_reconcile' | 'never_resend';
  runId?: string;
}

/**
 * 发送一个已 lease 的任务。
 *
 * 紧挨实际请求**再检查一次期限**：任务被领取后可能在队列里等了很久，
 * 等到真要发的时候已经过期了（§11.3）。
 */
export async function dispatch(task: OutboxTask, port: SendPort, now: number, opt: DispatchOptions = {}): Promise<DispatchResult> {
  const runId = opt.runId ?? 'live';
  if (now > task.deadlineAt) {
    markExpired(task.outboxId, now, '发送前复检已过期限，不补发成实时信号');
    return { outboxId: task.outboxId, state: 'expired', messageId: null, detail: '已过期限' };
  }

  let outcome: SendOutcome;
  if (task.op === 'edit') {
    const ref = messageRef(task.groupId, task.destination, task.mode, runId);
    const target = task.messageId ?? ref?.messageId ?? null;
    if (target === null) {
      finish(task.outboxId, 'failed', null, now, '没有可编辑的 messageId');
      return { outboxId: task.outboxId, state: 'failed', messageId: null, detail: '没有可编辑的 messageId' };
    }
    // 旧 revision 不能覆盖新 revision（乱序到达）。
    if (ref && ref.lastRevision > task.revision) {
      markExpired(task.outboxId, now, `已有 revision ${ref.lastRevision}，本任务 revision ${task.revision} 过时`);
      return { outboxId: task.outboxId, state: 'expired', messageId: target, detail: '旧 revision 不覆盖新 revision' };
    }
    outcome = await port.edit(target, task.payload.text, task.payload.markup);
    if (isUneditable(outcome)) {
      // 找不到/不可编辑：最多补一张带原 signalId 的修订卡，并记新引用；不能无限重建。
      if (task.attempt <= 2) {
        const repost = await port.send(task.payload.text, task.payload.markup);
        if (repost.kind === 'delivered') {
          commitDelivered(task, repost.messageId, now, runId, '原消息不可编辑，补发一张修订卡');
          return { outboxId: task.outboxId, state: 'sent', messageId: repost.messageId, detail: '补发修订卡' };
        }
      }
      finish(task.outboxId, 'failed', null, now, '原消息不可编辑且已达补发上限');
      return { outboxId: task.outboxId, state: 'failed', messageId: null, detail: '不可编辑' };
    }
  } else {
    outcome = await port.send(task.payload.text, task.payload.markup);
  }

  switch (outcome.kind) {
    case 'delivered':
      commitDelivered(task, outcome.messageId, now, runId, 'ok');
      return { outboxId: task.outboxId, state: 'sent', messageId: outcome.messageId, detail: 'ok' };

    case 'definiteFailure': {
      if (outcome.retryable) {
        const delay = outcome.retryAfterMs ?? Math.min(60_000, 2000 * 2 ** task.attempt);
        const due = now + delay;
        if (due > task.deadlineAt) {
          markExpired(task.outboxId, now, `退避到 ${new Date(due).toISOString()} 已超期限（${outcome.description}）`);
          return { outboxId: task.outboxId, state: 'expired', messageId: null, detail: outcome.description };
        }
        db.prepare(`UPDATE post_outbox SET state='pending', due_at=?, lease_until=NULL, last_error=?, updated_at=? WHERE outbox_id=?`)
          .run(due, `${outcome.code}: ${outcome.description}`.slice(0, 300), now, task.outboxId);
        return { outboxId: task.outboxId, state: 'pending', messageId: null, detail: `重排到 +${delay}ms` };
      }
      finish(task.outboxId, 'failed', null, now, `${outcome.code}: ${outcome.description}`);
      return { outboxId: task.outboxId, state: 'failed', messageId: null, detail: outcome.description };
    }

    case 'ambiguous': {
      // 不知道成没成。新建主卡默认不自动重发——宁可漏，不要重复刷屏，
      // 数量进运维待核对清单。已知 messageId 的 edit 可以安全重试。
      if (task.op === 'edit' && opt.ambiguousPolicy !== 'never_resend') {
        const due = now + 5000;
        if (due <= task.deadlineAt) {
          db.prepare(`UPDATE post_outbox SET state='pending', due_at=?, lease_until=NULL, last_error=?, updated_at=? WHERE outbox_id=?`)
            .run(due, `ambiguous(edit 可安全重试): ${outcome.description}`.slice(0, 300), now, task.outboxId);
          return { outboxId: task.outboxId, state: 'pending', messageId: null, detail: 'edit 重排' };
        }
      }
      finish(task.outboxId, 'unknown', null, now, `ambiguous: ${outcome.description}`);
      log.warn({ outboxId: task.outboxId, signalId: task.signalId },
        '发送结果未知，已进人工核对清单（不自动重发，可能漏通知）');
      return { outboxId: task.outboxId, state: 'unknown', messageId: null, detail: outcome.description };
    }
  }
}

function commitDelivered(task: OutboxTask, messageId: number, now: number, runId: string, detail: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE post_outbox SET state='sent', message_id=?, lease_until=NULL, last_error=?, updated_at=? WHERE outbox_id=?`)
      .run(messageId, detail, now, task.outboxId);
    // first_sent_at 只在 INSERT 时落，ON CONFLICT 的 UPDATE 不碰它——首次发送时间不能被改写。
    upsertRef.run(task.groupId, task.destination, task.mode, null, messageId, 1, task.revision, now, now, runId);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

function finish(id: string, state: OutboxState, messageId: number | null, now: number, detail: string): void {
  db.prepare(`UPDATE post_outbox SET state=?, message_id=COALESCE(?, message_id), lease_until=NULL, last_error=?, updated_at=? WHERE outbox_id=?`)
    .run(state, messageId, detail.slice(0, 300), now, id);
}

/** 重启恢复：回收超时 lease，把已过期限的 pending 归档。返回处理计数。 */
export function recover(now: number, runId = 'live'): { reaped: number; expired: number; pending: number; unknown: number } {
  const reaped = reapStaleLeases(now, runId);
  const expired = Number(db.prepare(
    `UPDATE post_outbox SET state='expired', last_error='重启恢复时已过期限，只归档不补发', updated_at=?
     WHERE run_id=? AND state='pending' AND deadline_at < ?`,
  ).run(now, runId, now).changes);
  const count = (s: string) => (db.prepare('SELECT COUNT(*) n FROM post_outbox WHERE run_id=? AND state=?').get(runId, s) as any).n;
  return { reaped, expired, pending: count('pending'), unknown: count('unknown') };
}

/** 运维视图：需要人工核对的 unknown 任务。 */
export function pendingReconcile(runId = 'live', limit = 100): OutboxTask[] {
  return (db.prepare(`SELECT * FROM post_outbox WHERE run_id=? AND state='unknown' ORDER BY updated_at DESC LIMIT ?`)
    .all(runId, limit) as any[]).map(toTask);
}

/** 人工把某条 unknown 关联到真实 messageId，或显式要求重发。 */
export function reconcile(id: string, action: 'link' | 'resend', messageId: number | null, now: number): boolean {
  if (action === 'link') {
    if (messageId === null) return false;
    const r = db.prepare(`UPDATE post_outbox SET state='sent', message_id=?, last_error='人工关联 messageId', updated_at=? WHERE outbox_id=? AND state='unknown'`)
      .run(messageId, now, id);
    return Number(r.changes) === 1;
  }
  const r = db.prepare(`UPDATE post_outbox SET state='pending', due_at=?, last_error='人工要求重发', updated_at=? WHERE outbox_id=? AND state='unknown'`)
    .run(now, now, id);
  return Number(r.changes) === 1;
}

export function outboxStats(runId = 'live'): Record<OutboxState, number> {
  const rows = db.prepare('SELECT state, COUNT(*) n FROM post_outbox WHERE run_id=? GROUP BY state').all(runId) as any[];
  const out: any = { pending: 0, sending: 0, sent: 0, unknown: 0, failed: 0, expired: 0 };
  for (const r of rows) out[r.state] = r.n;
  return out;
}
