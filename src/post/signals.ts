/**
 * 统一信号门控、去重与事务落库（设计文档 §10 / §11.1）。
 *
 * 事务边界很死（§10）：`BEGIN IMMEDIATE` 内只做
 *   检查 episode 的 last_processed_bar 与 revision（CAS）
 *   → 状态落库 → insert signal → insert outbox → commit。
 * 网络、LLM、Telegram 一律在事务外。
 *
 * `signalId` 由 (episode, eventType, eventSeq) 稳定生成，**不用 Date.now() 去重**：
 * 同一根闭合 K 重放、重启、重新拉历史都不会新增同一个确定性 signal。
 */
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import './store.js';
import { enqueue, type OutboxOp } from './outbox.js';
import type { Evaluation, SignalEventType } from './types.js';
import { SIGNAL_PRIORITY } from './types.js';
import type { NotifyMode } from '../notify/notifier.js';

export interface SignalInput {
  episodeId: string;
  chainId: number;
  ca: string;
  strategy: string;
  eventType: SignalEventType;
  eventSeq: number;
  /** 同币同一根桶的多个理由合成一张卡。 */
  groupKey: string;
  detectedAt: number;
  confirmedAt: number;
  barCloseTs: number;
  snapshot: Record<string, unknown>;
  quality: string;
  configHash: string;
  revision?: number;
  runId?: string;
}

export const signalIdFor = (episodeId: string, eventType: string, eventSeq: number, runId = 'live'): string =>
  `SL-${createHash('sha256').update([episodeId, eventType, eventSeq, runId].join('|')).digest('hex').slice(0, 12)}`;

export const groupIdFor = (chainId: number, ca: string, groupKey: string, runId = 'live'): string =>
  `G-${createHash('sha256').update([chainId, ca.toLowerCase(), groupKey, runId].join('|')).digest('hex').slice(0, 12)}`;

export interface NotificationTtlConfig {
  new_signal_ttl_minutes: number;
  range_ready_ttl_minutes: number;
  breakout_ttl_minutes: number;
  risk_ttl_minutes: number;
}

/** §11.3 的期限表。逾期不补发成实时信号，只进本地报告。 */
export function deadlineFor(eventType: SignalEventType, confirmedAt: number, ttl: NotificationTtlConfig): number {
  const M = 60_000;
  switch (eventType) {
    case 'NEW_PULLBACK_CONFIRMED':
    case 'MILLION_RECLAIM_CONFIRMED':
      return confirmedAt + ttl.new_signal_ttl_minutes * M;
    case 'SECOND_LEG_READY':
    case 'SPECULATIVE_WATCH':
      return confirmedAt + ttl.range_ready_ttl_minutes * M;
    case 'SECOND_LEG_BREAKOUT':
      return confirmedAt + ttl.breakout_ttl_minutes * M;
    default:
      // 失效、过热、修订等风险类一律按风险期限
      return confirmedAt + ttl.risk_ttl_minutes * M;
  }
}

export interface GateResult {
  /** 形态之外的门（叙事、量级、数据完整度）。全 pass 才能发标准确认卡。 */
  evaluations: Evaluation[];
  /** 只能发「仅观察」卡（重复题材）。 */
  speculativeOnly: boolean;
}

export interface PersistInput {
  signal: SignalInput;
  evaluations: Evaluation[];
  /** 渲染好的卡片文本。渲染是纯函数，可以在事务外先做好。 */
  payload: { text: string; markup?: unknown };
  op: OutboxOp;
  mode: NotifyMode;
  destination: string;
  ttl: NotificationTtlConfig;
  /** episode 的 CAS 校验：只有当前 revision 等于这个值才允许写。 */
  expectedEpisodeRevision?: number;
  episodeState?: { state: string; frozen?: unknown; clocks?: unknown; lastProcessedBar?: number; terminal?: boolean };
  /** 已有 messageId 时走 edit。 */
  messageId?: number | null;
  now: number;
}

export interface PersistResult {
  signalId: string;
  groupId: string;
  created: boolean;
  outboxId: string | null;
  reason: string;
}

const insertSignal = db.prepare(
  `INSERT INTO post_signals (signal_id, episode_id, chain_id, ca, strategy, event_type, event_seq,
     group_id, priority, detected_at, confirmed_at, bar_close_ts, snapshot, quality, config_hash, revision, run_id)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(episode_id, event_type, event_seq, run_id) DO NOTHING`,
);

const insertEval = db.prepare(
  `INSERT INTO post_evaluations (evaluation_id, episode_id, chain_id, ca, strategy, rule, result,
     observed, threshold, reason, as_of, available_at, input_hash, evidence_refs, run_id)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(evaluation_id) DO NOTHING`,
);

/**
 * 记录逐条 evaluation。**被拒样本也要留**，否则回答不了「为什么没推」。
 * 独立于信号：形态没成立的评估同样入库。
 */
export function recordEvaluations(
  evals: Evaluation[], ctx: { episodeId: string | null; chainId: number; ca: string; strategy: string; runId?: string },
): number {
  const runId = ctx.runId ?? 'live';
  let n = 0;
  for (const e of evals) {
    const id = `E-${createHash('sha256')
      .update([ctx.episodeId ?? '', ctx.ca, e.rule, e.asOf, e.result, runId].join('|'))
      .digest('hex').slice(0, 16)}`;
    const r = insertEval.run(id, ctx.episodeId, ctx.chainId, ctx.ca.toLowerCase(), ctx.strategy,
      e.rule, e.result, JSON.stringify(e.observed ?? null), JSON.stringify(e.threshold ?? null),
      e.reason, e.asOf, e.asOf, null, JSON.stringify(e.evidenceRefs), runId);
    n += Number(r.changes);
  }
  return n;
}

/**
 * 信号 + outbox 的原子提交。
 *
 * 幂等：同一 (episode, eventType, eventSeq, run) 只会有一条 signal；
 * outbox 同样按 (signal, op, revision, destination, mode, run) 去重。
 * 所以「同一闭合桶重复处理、重启、重新拉历史」都不会产生第二条通知。
 */
export function persistSignal(i: PersistInput): PersistResult {
  const runId = i.signal.runId ?? 'live';
  const signalId = signalIdFor(i.signal.episodeId, i.signal.eventType, i.signal.eventSeq, runId);
  const groupId = groupIdFor(i.signal.chainId, i.signal.ca, i.signal.groupKey, runId);
  const priority = SIGNAL_PRIORITY[i.signal.eventType] ?? 'P1';
  const revision = i.signal.revision ?? 1;

  db.exec('BEGIN IMMEDIATE');
  try {
    // CAS：拿到的 episode 版本跟计算时不一致，说明有更新的状态，本次结果作废。
    if (i.expectedEpisodeRevision !== undefined) {
      const cur = db.prepare('SELECT revision, terminal FROM post_episodes WHERE episode_id=?').get(i.signal.episodeId) as any;
      if (cur && cur.revision !== i.expectedEpisodeRevision) {
        db.exec('ROLLBACK');
        return { signalId, groupId, created: false, outboxId: null, reason: `episode revision 已变（${cur.revision} ≠ ${i.expectedEpisodeRevision}），丢弃本次计算结果` };
      }
    }

    if (i.episodeState) {
      db.prepare(
        `UPDATE post_episodes SET state=?, state_since=?, frozen=?, clocks=?, last_processed_bar=?,
           terminal=?, revision=revision+1, updated_at=? WHERE episode_id=?`,
      ).run(i.episodeState.state, i.now,
        i.episodeState.frozen === undefined ? null : JSON.stringify(i.episodeState.frozen),
        i.episodeState.clocks === undefined ? null : JSON.stringify(i.episodeState.clocks),
        i.episodeState.lastProcessedBar ?? null, i.episodeState.terminal ? 1 : 0, i.now, i.signal.episodeId);
    }

    const r = insertSignal.run(signalId, i.signal.episodeId, i.signal.chainId, i.signal.ca.toLowerCase(),
      i.signal.strategy, i.signal.eventType, i.signal.eventSeq, groupId, priority,
      i.signal.detectedAt, i.signal.confirmedAt, i.signal.barCloseTs,
      JSON.stringify(i.signal.snapshot), i.signal.quality, i.signal.configHash, revision, runId);
    const created = Number(r.changes) === 1;

    recordEvaluations(i.evaluations, {
      episodeId: i.signal.episodeId, chainId: i.signal.chainId, ca: i.signal.ca,
      strategy: i.signal.strategy, runId,
    });

    let outboxId: string | null = null;
    if (created) {
      outboxId = enqueue({
        signalId, groupId, op: i.op, revision, destination: i.destination, mode: i.mode,
        dueAt: i.now,
        deadlineAt: deadlineFor(i.signal.eventType, i.signal.confirmedAt, i.ttl),
        payload: { text: i.payload.text, markup: i.payload.markup, priority },
        messageId: i.messageId ?? null,
        runId,
      }, i.now);
    }
    db.exec('COMMIT');
    return {
      signalId, groupId, created, outboxId,
      reason: created ? '新信号已入队' : '同一确定性信号已存在，不重复入队',
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 同一 token 同一分钟的多个理由合并（§11.1）。
 * 保留每一个原始 signalId，不因为跨策略冷却把失效信息吞掉。
 */
export interface MergedGroup {
  groupKey: string;
  reasons: { eventType: SignalEventType; signalId: string; reason: string }[];
  priority: 'P0' | 'P1' | 'P2';
}

export function mergeReasons(
  items: { eventType: SignalEventType; episodeId: string; eventSeq: number; reason: string }[],
  chainId: number, ca: string, groupKey: string, runId = 'live',
): MergedGroup {
  const reasons = items.map(x => ({
    eventType: x.eventType,
    signalId: signalIdFor(x.episodeId, x.eventType, x.eventSeq, runId),
    reason: x.reason,
  }));
  const priority = items
    .map(x => SIGNAL_PRIORITY[x.eventType] ?? 'P1')
    .sort((a, b) => ({ P0: 0, P1: 1, P2: 2 }[a] - { P0: 0, P1: 1, P2: 2 }[b]))[0] ?? 'P1';
  return { groupKey: groupIdFor(chainId, ca, groupKey, runId), reasons, priority };
}

export function recentSignals(runId = 'live', sinceTs = 0, limit = 200): any[] {
  return db.prepare(
    `SELECT * FROM post_signals WHERE run_id=? AND confirmed_at >= ? ORDER BY confirmed_at DESC LIMIT ?`,
  ).all(runId, sinceTs, limit) as any[];
}

export function signalById(signalId: string): any | null {
  return (db.prepare('SELECT * FROM post_signals WHERE signal_id=?').get(signalId) as any) ?? null;
}
