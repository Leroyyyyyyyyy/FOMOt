import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { migratePostSchema, POST_TABLES } from '../src/post/store.js';
import {
  enqueue, lease, dispatch, recover, reapStaleLeases, messageRef, offPort,
  pendingReconcile, reconcile, outboxStats, type SendPort, type OutboxTask,
} from '../src/post/outbox.js';
import { persistSignal, signalIdFor, groupIdFor, deadlineFor, recordEvaluations, mergeReasons } from '../src/post/signals.js';
import { pass, fail } from '../src/post/types.js';

migratePostSchema();
test.beforeEach(() => { for (const t of POST_TABLES) db.exec(`DELETE FROM ${t}`); });

const NOW = 1_800_000_000_000;
const M = 60_000;
const ttl = { new_signal_ttl_minutes: 5, range_ready_ttl_minutes: 30, breakout_ttl_minutes: 10, risk_ttl_minutes: 5 };

function episode(id = 'E1') {
  db.prepare(`INSERT INTO post_episodes (episode_id, chain_id, ca, strategy, anchor_id, state, state_since,
      config_hash, created_at, updated_at) VALUES (?,4663,'0xca','second_leg','a','RANGE_TRACKING',?,'h',?,?)`)
    .run(id, NOW, NOW, NOW);
  return id;
}

function persist(over: any = {}) {
  return persistSignal({
    signal: {
      episodeId: over.episodeId ?? 'E1', chainId: 4663, ca: '0xca', strategy: 'second_leg',
      eventType: over.eventType ?? 'SECOND_LEG_READY', eventSeq: over.eventSeq ?? 1,
      groupKey: over.groupKey ?? 'bar-1', detectedAt: NOW, confirmedAt: over.confirmedAt ?? NOW,
      barCloseTs: NOW, snapshot: { a: 1 }, quality: 'complete', configHash: 'cfg1',
      revision: over.revision ?? 1,
    },
    evaluations: over.evaluations ?? [pass('r1', 1, 1, 'ok', NOW)],
    payload: { text: over.text ?? '卡片' },
    op: over.op ?? 'send',
    mode: over.mode ?? 'off',
    destination: 'tg',
    ttl,
    messageId: over.messageId ?? null,
    episodeState: over.episodeState,
    expectedEpisodeRevision: over.expectedEpisodeRevision,
    now: over.now ?? NOW,
  });
}

/** 断言任意网络调用都没发生。 */
function withNetworkGuard<T>(fn: () => T): T {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (...args: any[]) => { calls++; throw new Error(`不应发生网络调用: ${String(args[0])}`); }) as any;
  try {
    const r = fn();
    assert.equal(calls, 0, '禁发送模式下网络调用必须为 0');
    return r;
  } finally { globalThis.fetch = real; }
}

// ── 信号去重与事务 ─────────────────────────────────────────────────────────

test('signalId 由 episode/eventType/eventSeq 稳定生成，不依赖 Date.now()', () => {
  const a = signalIdFor('E1', 'SECOND_LEG_READY', 1);
  const b = signalIdFor('E1', 'SECOND_LEG_READY', 1);
  assert.equal(a, b);
  assert.notEqual(a, signalIdFor('E1', 'SECOND_LEG_READY', 2));
  assert.notEqual(a, signalIdFor('E1', 'SECOND_LEG_READY', 1, 'replay-1'), '回放 runId 必须隔离');
});

test('同一确定性信号重复处理不会二次入队', () => {
  episode();
  const first = persist();
  assert.equal(first.created, true);
  assert.ok(first.outboxId);
  const second = persist();
  assert.equal(second.created, false);
  assert.equal(second.outboxId, null);
  assert.equal(second.signalId, first.signalId);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM post_outbox').get() as any).n, 1);
});

test('episode revision 变了就丢弃本次计算结果（CAS）', () => {
  episode();
  db.prepare('UPDATE post_episodes SET revision=5 WHERE episode_id=?').run('E1');
  const r = persist({ expectedEpisodeRevision: 1 });
  assert.equal(r.created, false);
  assert.match(r.reason, /revision 已变/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM post_signals').get() as any).n, 0, '不能留下半条信号');
});

test('被拒样本的 evaluation 也入库——要能回答「为什么没推」', () => {
  const n = recordEvaluations(
    [fail('second_leg.zone_visits', 2, 3, '区域往返只有 2 次', NOW)],
    { episodeId: null, chainId: 4663, ca: '0xca', strategy: 'second_leg' });
  assert.equal(n, 1);
  const row = db.prepare("SELECT * FROM post_evaluations WHERE result='fail'").get() as any;
  assert.match(row.reason, /区域往返只有 2 次/);
});

test('期限表按事件类型区分（§11.3）', () => {
  assert.equal(deadlineFor('NEW_PULLBACK_CONFIRMED', NOW, ttl), NOW + 5 * M);
  assert.equal(deadlineFor('SECOND_LEG_READY', NOW, ttl), NOW + 30 * M);
  assert.equal(deadlineFor('SECOND_LEG_BREAKOUT', NOW, ttl), NOW + 10 * M);
  assert.equal(deadlineFor('RSI_OVERHEAT', NOW, ttl), NOW + 5 * M);
});

test('同币同桶的多个理由合并成一组，但保留每个原始 signalId', () => {
  const g = mergeReasons([
    { eventType: 'NEW_PULLBACK_CONFIRMED', episodeId: 'E1', eventSeq: 1, reason: '两次回拉确认' },
    { eventType: 'MILLION_RECLAIM_CONFIRMED', episodeId: 'E2', eventSeq: 1, reason: '关口回踩新高' },
  ], 4663, '0xca', 'bar-1');
  assert.equal(g.reasons.length, 2);
  assert.equal(new Set(g.reasons.map(r => r.signalId)).size, 2);
  assert.equal(g.groupKey, groupIdFor(4663, '0xca', 'bar-1'));
});

// ── outbox 状态机 ──────────────────────────────────────────────────────────

const okPort = (): SendPort => ({
  async send() { return { kind: 'delivered', messageId: 111 }; },
  async edit(id) { return { kind: 'delivered', messageId: id }; },
});

test('off 模式跑完整条发送状态机，且网络调用为 0', async () => {
  episode();
  const port = offPort();
  await withNetworkGuard(async () => {
    persist();
    const t = lease('off', NOW)!;
    assert.ok(t, '必须能领到任务');
    const r = await dispatch(t, port, NOW);
    assert.equal(r.state, 'sent');
    assert.ok(messageRef(t.groupId, 'tg', 'off')!.delivered);
  });
});

test('off 与 telegram 的 message 引用严格隔离', () => {
  episode();
  persist({ mode: 'off', eventSeq: 1 });
  persist({ mode: 'telegram', eventSeq: 2 });
  const gid = groupIdFor(4663, '0xca', 'bar-1');
  db.prepare(`INSERT INTO post_message_refs (group_id,destination,mode,message_id,delivered,last_revision,updated_at,run_id)
    VALUES (?,?,?,?,1,1,?, 'live')`).run(gid, 'tg', 'off', 900, NOW);
  assert.equal(messageRef(gid, 'tg', 'off')!.messageId, 900);
  assert.equal(messageRef(gid, 'tg', 'telegram'), null, 'off 的演练 messageId 不能被当成真实已送达');
});

test('429 属于明确未成功，按 retry_after 重排而不是当失败', async () => {
  episode();
  persist();
  const t = lease('off', NOW)!;
  const port: SendPort = {
    async send() { return { kind: 'definiteFailure', retryable: true, retryAfterMs: 7000, code: 429, description: 'Too Many Requests' }; },
    async edit() { throw new Error('不应调用'); },
  };
  const r = await dispatch(t, port, NOW);
  assert.equal(r.state, 'pending');
  const row = db.prepare('SELECT due_at, state FROM post_outbox WHERE outbox_id=?').get(t.outboxId) as any;
  assert.equal(row.due_at, NOW + 7000);
});

test('403 进 failed，不持续轰炸', async () => {
  episode();
  persist();
  const t = lease('off', NOW)!;
  const r = await dispatch(t, {
    async send() { return { kind: 'definiteFailure', retryable: false, retryAfterMs: null, code: 403, description: 'Forbidden' }; },
    async edit() { throw new Error('不应调用'); },
  }, NOW);
  assert.equal(r.state, 'failed');
});

test('send 超时 → unknown，新建主卡默认不自动重发，进人工核对清单', async () => {
  episode();
  persist();
  const t = lease('off', NOW)!;
  const r = await dispatch(t, {
    async send() { return { kind: 'ambiguous', description: 'TimeoutError' }; },
    async edit() { throw new Error('不应调用'); },
  }, NOW);
  assert.equal(r.state, 'unknown');
  assert.equal(pendingReconcile().length, 1, '必须进人工核对清单');
  assert.equal(lease('off', NOW + 1000), null, 'unknown 不会被自动重新领取');
});

test('人工核对可以关联 messageId 或显式要求重发', async () => {
  episode();
  persist();
  const t = lease('off', NOW)!;
  await dispatch(t, { async send() { return { kind: 'ambiguous', description: 'x' }; }, async edit() { throw 0; } }, NOW);
  assert.equal(reconcile(t.outboxId, 'link', 777, NOW), true);
  assert.equal((db.prepare('SELECT state, message_id FROM post_outbox WHERE outbox_id=?').get(t.outboxId) as any).message_id, 777);
});

test('已知 messageId 的 edit 超时可以安全重试', async () => {
  episode();
  persist({ op: 'edit', messageId: 555, eventType: 'SECOND_LEG_BREAKOUT' });
  const t = lease('off', NOW)!;
  const r = await dispatch(t, {
    async send() { throw new Error('不应调用 send'); },
    async edit() { return { kind: 'ambiguous', description: 'TimeoutError' }; },
  }, NOW);
  assert.equal(r.state, 'pending', 'edit 幂等，可以重排');
});

test('过期任务只归档，不补发成实时信号', async () => {
  episode();
  persist({ eventType: 'NEW_PULLBACK_CONFIRMED', confirmedAt: NOW - 10 * M });
  const t = lease('off', NOW);
  assert.equal(t, null, '已过 5 分钟期限的任务不应被领取');
  assert.equal(outboxStats().expired, 1);
});

test('领取后在队列里等太久，紧挨发送前再检查一次期限', async () => {
  episode();
  persist({ eventType: 'SECOND_LEG_BREAKOUT' });
  const t = lease('off', NOW)!;
  const r = await dispatch(t, okPort(), NOW + 11 * M);   // 突破期限 10 分钟
  assert.equal(r.state, 'expired');
  assert.match(r.detail, /已过期限/);
});

test('lease 超时一律按「可能已发」转 unknown，不直接当 pending', () => {
  episode();
  persist();
  const t = lease('off', NOW, 1000)!;
  assert.equal(reapStaleLeases(NOW + 5000), 1);
  assert.equal((db.prepare('SELECT state FROM post_outbox WHERE outbox_id=?').get(t.outboxId) as any).state, 'unknown');
});

test('重启恢复：回收超时 lease、归档过期 pending，pending 任务原样保留', () => {
  episode();
  persist({ eventSeq: 1, groupKey: 'g1' });
  persist({ eventSeq: 2, groupKey: 'g2' });
  lease('off', NOW, 1000);                                   // 一条变 sending
  const r = recover(NOW + 5000);
  assert.equal(r.reaped, 1);
  assert.equal(r.pending, 1, '另一条 pending 必须原样保留，重启不能丢任务');
  assert.equal(r.unknown, 1);
});

test('旧 revision 的编辑不覆盖新 revision（乱序到达）', async () => {
  episode();
  const gid = groupIdFor(4663, '0xca', 'bar-1');
  db.prepare(`INSERT INTO post_message_refs (group_id,destination,mode,message_id,delivered,last_revision,updated_at,run_id)
    VALUES (?,?,?,?,1,5,?, 'live')`).run(gid, 'tg', 'off', 321, NOW);
  persist({ op: 'edit', messageId: 321, revision: 2, eventType: 'SECOND_LEG_INVALIDATED' });
  const t = lease('off', NOW)!;
  const r = await dispatch(t, okPort(), NOW);
  assert.equal(r.state, 'expired');
  assert.match(r.detail, /旧 revision 不覆盖新 revision/);
});

test('P0 优先，但等待过久的 P1 不会被永久饿死', () => {
  // 这个用例只测排队顺序，不需要 episode
  // P1 先入队且已经等了很久
  enqueue({ signalId: 's-p1', groupId: 'g1', op: 'send', destination: 'tg', mode: 'off',
    dueAt: NOW - 5 * M, deadlineAt: NOW + 30 * M, payload: { text: 'p1', priority: 'P1' } }, NOW - 5 * M);
  enqueue({ signalId: 's-p0', groupId: 'g2', op: 'send', destination: 'tg', mode: 'off',
    dueAt: NOW, deadlineAt: NOW + 30 * M, payload: { text: 'p0', priority: 'P0' } }, NOW);
  const t = lease('off', NOW)!;
  assert.equal(t.signalId, 's-p1', '等待超过饿死阈值的 P1 必须先走');
});

test('同时到达时 P0 优先于 P1', () => {
  enqueue({ signalId: 's-p1', groupId: 'g1', op: 'send', destination: 'tg', mode: 'off',
    dueAt: NOW, deadlineAt: NOW + 30 * M, payload: { text: 'p1', priority: 'P1' } }, NOW);
  enqueue({ signalId: 's-p0', groupId: 'g2', op: 'send', destination: 'tg', mode: 'off',
    dueAt: NOW, deadlineAt: NOW + 30 * M, payload: { text: 'p0', priority: 'P0' } }, NOW);
  assert.equal(lease('off', NOW)!.signalId, 's-p0');
});

test('原消息不可编辑时最多补一张修订卡，不无限重建', async () => {
  episode();
  persist({ op: 'edit', messageId: 999, eventType: 'SECOND_LEG_INVALIDATED' });
  const t = lease('off', NOW)!;
  let sends = 0;
  const r = await dispatch(t, {
    async send() { sends++; return { kind: 'delivered', messageId: 1234 }; },
    async edit() { return { kind: 'definiteFailure', retryable: false, retryAfterMs: null, code: 400, description: 'message to edit not found' }; },
  }, NOW);
  assert.equal(r.state, 'sent');
  assert.equal(sends, 1, '只补发一张，带原 signalId');
  assert.equal(r.messageId, 1234);
});

test('禁发送模式下恢复、编辑、错误路径都不产生网络调用', async () => {
  episode();
  const port = offPort();
  await withNetworkGuard(async () => {
    persist({ eventSeq: 1, groupKey: 'a' });
    const t1 = lease('off', NOW)!;
    await dispatch(t1, port, NOW);
    persist({ eventSeq: 2, groupKey: 'a', op: 'edit', messageId: 111, eventType: 'SECOND_LEG_BREAKOUT' });
    const t2 = lease('off', NOW)!;
    await dispatch(t2, port, NOW);
    recover(NOW + 1000);
    reapStaleLeases(NOW + 1000);
    pendingReconcile();
  });
});
