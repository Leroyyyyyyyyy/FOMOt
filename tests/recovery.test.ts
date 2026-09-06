import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { Engine } from '../src/engine/index.js';
import { nullFomo } from '../src/fomo/provider.js';
import { Notifier } from '../src/notify/notifier.js';
import { addr } from './helpers/fixtures.js';

const CA = addr(0xbeef);
const offNotifier = new Notifier('off');

const clean = () => { db.exec('DELETE FROM alerts'); db.exec('DELETE FROM notification_log'); };
test.beforeEach(clean);

function insertAlert(over: Record<string, unknown> = {}) {
  const row = {
    ca: CA, trigger_ts: 1000, message_id: null as number | null, payload: null as string | null,
    status: 'pending_recheck', recheck_due_ts: 2000, original_due_ts: 2000,
    attempts: 0, collection_state: 'pending', ...over,
  };
  db.prepare(`INSERT INTO alerts (ca,trigger_ts,message_id,payload,status,recheck_due_ts,original_due_ts,attempts,collection_state)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(
    row.ca, row.trigger_ts, row.message_id, row.payload, row.status,
    row.recheck_due_ts, row.original_due_ts, row.attempts, row.collection_state);
  return row;
}
const get = (triggerTs = 1000) => db.prepare('SELECT * FROM alerts WHERE ca=? AND trigger_ts=?').get(CA, triggerTs) as any;

/** 一份结构完整、能被 JSON.parse 出来的 payload */
const goodPayload = (triggerTs = 1000) => JSON.stringify({
  m: { ca: CA, symbol: 'T', name: 'T', decimals: 18, marketCapUsd: 1, volume5m: 1, volume1h: 1 },
  triggerTs, initialTotal: 100, initE: {}, initialOffsetMs: 800,
  messageId: 7, originalDueTs: triggerTs + 301_000, recheckDueTs: triggerTs + 301_000, attempts: 0,
});

test('正常退出留下的 pending_recheck 会被恢复', () => {
  insertAlert({ payload: goodPayload(), message_id: 7 });
  const ac = new AbortController();
  ac.abort();                                       // 立刻中止，避免真的去跑复核
  const e = new Engine(nullFomo, ac.signal, offNotifier);
  const r = e.resumePending();
  assert.equal(r.resumed, 1);
  assert.equal(r.corrupt, 0);
});

test('重复恢复不会把同一条任务接管两次', () => {
  insertAlert({ payload: goodPayload(), message_id: 7 });
  const ac = new AbortController(); ac.abort();
  const e = new Engine(nullFomo, ac.signal, offNotifier);
  assert.equal(e.resumePending().resumed, 1);
  assert.equal(e.resumePending().resumed, 0, '第二次恢复必须是空操作');
});

test('损坏的 payload 被标为降级，不会崩，也不会当成完成', () => {
  insertAlert({ payload: '{这不是合法 JSON', message_id: 7 });
  const ac = new AbortController(); ac.abort();
  const r = new Engine(nullFomo, ac.signal, offNotifier).resumePending();
  assert.equal(r.corrupt, 1);
  assert.equal(r.resumed, 0);
  const row = get();
  assert.equal(row.status, 'abandoned');
  assert.equal(row.collection_state, 'degraded');
  assert.notEqual(row.status, 'completed');
  assert.match(row.last_error, /恢复 payload 失败/);
});

test('结构不完整的 payload 也算损坏', () => {
  insertAlert({ payload: JSON.stringify({ nope: 1 }), message_id: 7 });
  const ac = new AbortController(); ac.abort();
  assert.equal(new Engine(nullFomo, ac.signal, offNotifier).resumePending().corrupt, 1);
  assert.equal(get().status, 'abandoned');
});

test('pending_recheck 但没有 payload：标降级，不静默丢弃', () => {
  insertAlert({ payload: null });
  const ac = new AbortController(); ac.abort();
  assert.equal(new Engine(nullFomo, ac.signal, offNotifier).resumePending().corrupt, 1);
  assert.equal(get().status, 'abandoned');
});

test('强制退出遗留的 firing：没发过卡就删掉占位行，不拉黑这个币', () => {
  insertAlert({ status: 'firing', payload: null });
  const ac = new AbortController(); ac.abort();
  const r = new Engine(nullFomo, ac.signal, offNotifier).resumePending();
  assert.equal(r.orphanFiring, 1);
  assert.equal(get(), undefined, '幽灵占位行必须被清掉');
});

test('崩溃窗口：发送成功但状态未落库，靠本地通知记录识别出来', () => {
  insertAlert({ status: 'firing', payload: null });
  // 通知记录器在状态落库**之前**就写了这一条——这是唯一的证据
  db.prepare(`INSERT INTO notification_log (ts,mode,op,message_id,ca,trigger_ts,ok,detail)
              VALUES (?,'off','send',424242,?,?,1,'卡片正文')`).run(Date.now(), CA, 1000);
  const ac = new AbortController(); ac.abort();
  const r = new Engine(nullFomo, ac.signal, offNotifier).resumePending();
  assert.equal(r.orphanFiring, 1);
  const row = get();
  assert.ok(row, '已经发出去的卡片不能被当作没发过而删除');
  assert.equal(row.status, 'abandoned');
  assert.equal(row.collection_state, 'degraded');
  assert.match(row.last_error, /424242/);
});

test('失败的发送记录不算「已发出」', () => {
  insertAlert({ status: 'firing', payload: null });
  db.prepare(`INSERT INTO notification_log (ts,mode,op,message_id,ca,trigger_ts,ok,detail)
              VALUES (?,'off','send',NULL,?,?,0,'send 失败')`).run(Date.now(), CA, 1000);
  const ac = new AbortController(); ac.abort();
  new Engine(nullFomo, ac.signal, offNotifier).resumePending();
  assert.equal(get(), undefined);
});

test('过期的 firing 与正常 pending 混在一起时各走各的路', () => {
  insertAlert({ trigger_ts: 1000, status: 'firing', payload: null });
  insertAlert({ trigger_ts: 2000, status: 'pending_recheck', payload: goodPayload(2000), message_id: 9 });
  const ac = new AbortController(); ac.abort();
  const r = new Engine(nullFomo, ac.signal, offNotifier).resumePending();
  assert.equal(r.orphanFiring, 1);
  assert.equal(r.resumed, 1);
  assert.equal(get(1000), undefined);
  assert.equal(get(2000).status, 'pending_recheck');
});

test('已终结的记录不会被重复完成', () => {
  insertAlert({ status: 'completed', collection_state: 'complete', payload: goodPayload() });
  const done = db.prepare(
    `UPDATE alerts SET status='completed', collection_state='degraded', last_error='二次完成'
     WHERE ca=? AND trigger_ts=? AND status='pending_recheck'`).run(CA, 1000);
  assert.equal(done.changes, 0, '条件更新必须挡住重复完成');
  assert.equal(get().collection_state, 'complete');
});

test('禁发送模式下的通知全部进本地记录器', async () => {
  const n = new Notifier('off');
  assert.equal(n.canSend, false);
  const sent = await n.send('<b>卡片</b>', {}, { ca: CA, triggerTs: 1000 });
  assert.ok(sent && sent.messageId > 0, '禁发送模式也要给出稳定的本地 message_id');
  assert.equal(sent!.delivered, false);
  assert.equal(await n.edit(sent!.messageId, '改写', {}, { ca: CA, triggerTs: 1000 }), true);
  assert.equal(await n.remove(sent!.messageId, { ca: CA, triggerTs: 1000 }), true);

  const ops = db.prepare('SELECT op, mode, ok FROM notification_log WHERE ca=? ORDER BY id').all(CA) as any[];
  assert.deepEqual(ops.map(o => o.op), ['send', 'edit', 'remove']);
  assert.ok(ops.every(o => o.mode === 'off' && o.ok === 1));
});
