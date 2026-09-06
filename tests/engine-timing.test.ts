import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { Engine, type StageResult, type SourceTimes } from '../src/engine/index.js';
import { enrichSocial, type Enriched } from '../src/engine/enrich.js';
import { DAY_MS, HOUR_MS, type PnlRecord } from '../src/engine/pnl.js';
import { renderCard } from '../src/notify/render.js';
import { Notifier } from '../src/notify/notifier.js';
import type { FomoProvider, PlatformPnlResult } from '../src/fomo/provider.js';
import { addr, snapshot, statsFromPnls } from './helpers/fixtures.js';

const CA = addr(0xfeed);
/**
 * 时间基准取「现在」：窗口新鲜度、补取截止时间都是相对当前时钟判定的，
 * 用写死的历史时间戳会让这些校验一律判过期——那测的就不是本意了。
 */
const TRIGGER = Date.now() - 301_000;
const DUE = TRIGGER + 301_000;
const WIN_END = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
const off = new Notifier('off');

const market = {
  ca: CA, symbol: 'MEME', name: 'A Meme Coin', decimals: 18,
  priceUsd: 0.001, marketCapUsd: 126_120, volume5m: 22_360, volume1h: 212_120,
  swaps5m: 10, poolAgeMs: 60_000,
};

const times = (over: Partial<SourceTimes> = {}): SourceTimes => ({
  chainBlock: '55121759', chainBlockTs: TRIGGER + 500, chainTakenTs: TRIGGER + 700,
  fomoRespTs: TRIGGER + 750, boardTakenTs: TRIGGER + 600,
  marketTakenTs: TRIGGER + 800, aggregatedTs: TRIGGER + 800, ...over,
});

const enriched = (fomoHolders = 72): Enriched =>
  enrichSocial(18, snapshot(), statsFromPnls(Array(10).fill(1), { fomoHolders }), [], true);

const stage = (total: number, holdersDoneTs: number, over: Partial<SourceTimes> = {}, fomoHolders = 72): StageResult =>
  ({ total, e: enriched(fomoHolders), holdersDoneTs, times: times(over) });

function storedState(withRecheck = true) {
  return {
    v: 2, m: market, triggerTs: TRIGGER, messageId: 4242,
    originalDueTs: DUE, recheckDueTs: DUE, attempts: 0,
    // 持币在触发后第 0.8 秒采完初值、第 301 秒采完复核
    initial: stage(178, TRIGGER + 800),
    ...(withRecheck ? { recheck: stage(491, TRIGGER + 301_000, {}, 336) } : {}),
  } as any;
}

const record = (userId: string, value: number): PnlRecord => ({
  userId, value, source: 'aggregated_snapshot', basis: 'snapshot',
  windowStartTs: WIN_END - DAY_MS, windowEndTs: WIN_END, fetchedTs: DUE + 59_000,
});
/** 十个人的收益：含正、负、零，用来核对总和与盈利人数 */
const TEN = [500_000, 120_000, -52_360, 0, 30_000, 10, -3, 7_000, 2_500, 1];
const tenRecords = () => new Map(TEN.map((v, i) => [`u${i}`, record(`u${i}`, v)]));

class FakeFomo implements FomoProvider {
  ready = true;
  calls: { ids: string[]; endTs: number }[] = [];
  gate: Promise<void> = Promise.resolve();
  result: PlatformPnlResult = {
    window: { basis: 'snapshot', startTs: WIN_END - DAY_MS, endTs: WIN_END },
    records: tenRecords(), misses: new Map(), elapsedMs: 1, cacheHits: 0,
  };
  tokenStatsWarm() { return true; }
  async leaderboard24h() { return []; }
  async tokenStats() { return null; }
  async platformPnl24h(ids: string[], endTs: number): Promise<PlatformPnlResult> {
    this.calls.push({ ids, endTs });
    await this.gate;
    return this.result;
  }
  ingestLatencyMs() { return 1; }
}

const clean = () => { db.exec('DELETE FROM alerts'); db.exec('DELETE FROM notification_log'); };
test.beforeEach(clean);

function seedAlert(status: string, over: Record<string, unknown> = {}) {
  const row = { payload: JSON.stringify(storedState()), pnl_state: 'off', pnl_deadline_ts: null, ...over };
  db.prepare(`INSERT INTO alerts (ca,trigger_ts,message_id,payload,status,recheck_due_ts,original_due_ts,attempts,collection_state,pnl_state,pnl_deadline_ts)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(CA, TRIGGER, 4242, row.payload as string, status, DUE, DUE, 0, 'pending', row.pnl_state as string, row.pnl_deadline_ts as any);
}
const alertRow = () => db.prepare('SELECT * FROM alerts WHERE ca=? AND trigger_ts=?').get(CA, TRIGGER) as any;
const edits = () => db.prepare("SELECT COUNT(*) n FROM notification_log WHERE op='edit'").get() as any;
const lastCard = () => (db.prepare(
  "SELECT detail FROM notification_log WHERE op='edit' ORDER BY id DESC LIMIT 1").get() as any)?.detail as string | undefined;

// ── 任务四：时间语义 ─────────────────────────────────────────────────

test('持币第 301 秒采完、PnL 第 360 秒才完成，持币偏移仍是 +5m1s', () => {
  const e = new Engine(new FakeFomo(), new AbortController().signal, off);
  const state = storedState();
  const before = renderCard((e as any).buildCard(state, 'collecting'));
  assert.match(before, /持币初值（\+0\.8s）: 全链 178/);
  assert.match(before, /持币复核（\+5m1s）: 全链 491/);
  assert.match(before, /Top10持币账户（\+5m1s）/);
  assert.match(before.replace(/<[^>]+>/g, ''), /全平台24H PnL: 采集中…/);

  // PnL 在第 360 秒才拿到 —— 偏移不能因此被撑成 +6m0s
  state.recheck.e = { ...state.recheck.e };
  const after = renderCard((e as any).buildCard(state, 'ready'));
  assert.match(after, /持币复核（\+5m1s）/, 'PnL 的耗时不属于持币采集阶段');
  assert.match(after, /Top10持币账户（\+5m1s）/);
});

test('后续补 PnL 不修改已保存的初值、复核人数和采集时间', async () => {
  const fomo = new FakeFomo();
  const e = new Engine(fomo, new AbortController().signal, off);
  const state = storedState();
  seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: DUE + 600_000 });
  const snapBefore = { initial: state.initial.holdersDoneTs, recheck: state.recheck.holdersDoneTs,
    initTotal: state.initial.total, reTotal: state.recheck.total, times: JSON.stringify(state.recheck.times) };

  const ok = await (e as any).applyPnl(state, { window: fomo.result.window, records: tenRecords(),
    members: state.recheck.e.top10Members, fetchedTs: DUE + 59_000 });
  assert.equal(ok, true);
  assert.equal(state.initial.holdersDoneTs, snapBefore.initial, '初值采集时间不变');
  assert.equal(state.recheck.holdersDoneTs, snapBefore.recheck, '复核采集时间不变');
  assert.equal(state.initial.total, snapBefore.initTotal, '初值人数不变');
  assert.equal(state.recheck.total, snapBefore.reTotal, '复核人数不变');
  assert.equal(JSON.stringify(state.recheck.times), snapBefore.times, '各来源时间不变');

  const card = lastCard()!.replace(/<[^>]+>/g, '');
  assert.match(card, /持币初值（\+0\.8s）: 全链 178/);
  assert.match(card, /持币复核（\+5m1s）: 全链 491/);
  // 十人：正 7、零 1、负 2 → 合计与盈利人数各自正确
  assert.match(card, /全平台24H PnL: \+\$607\.15K · 盈利 7 人 · 整点对齐口径/);
  assert.equal(alertRow().pnl_state, 'ready');
});

test('数据源时间差超限时卡片给出降级信息', () => {
  const e = new Engine(new FakeFomo(), new AbortController().signal, off);
  const state = storedState();
  // FOMO 侧比链上晚了 5 分钟：两者不能无条件当成同一时点
  state.recheck.times.fomoRespTs = state.recheck.times.chainTakenTs + 300_000;
  const card = renderCard((e as any).buildCard(state, 'ready')).replace(/<[^>]+>/g, '');
  assert.match(card, /⚠️ 数据时点: 链上与 Fomo 采集相差 300s/);
});

test('链上区块时间与采集完成时间分别保留，不互相替代', () => {
  const e = new Engine(new FakeFomo(), new AbortController().signal, off);
  const data = (e as any).buildCard(storedState(), 'ready');
  assert.equal(data.sources.chainBlock, '55121759');
  assert.notEqual(data.sources.chainBlockTs, data.sources.chainTakenTs);
  assert.notEqual(data.sources.chainTakenTs, data.sources.fomoRespTs);
  assert.equal(data.sources.sourceSkewMs, 50);
  assert.equal(data.top10.offsetMs, 301_000, 'Top10 集合时间 = 持币采集阶段完成偏移');
});

test('PnL 窗口的起止与获取时间在卡片数据里都能追溯', async () => {
  const fomo = new FakeFomo();
  const e = new Engine(fomo, new AbortController().signal, off);
  const state = storedState();
  seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: DUE + 600_000 });
  await (e as any).applyPnl(state, { window: fomo.result.window, records: tenRecords(),
    members: state.recheck.e.top10Members, fetchedTs: DUE + 59_000 });
  const data = (e as any).buildCard(state, 'ready');
  assert.equal(data.top10.platformWindow.endTs - data.top10.platformWindow.startTs, DAY_MS);
  assert.equal(data.top10.platformFetchedTs, DUE + 59_000);
  assert.notEqual(data.top10.platformWindow.endTs, data.top10.platformFetchedTs,
    '窗口结束时间与获取时间必须分开');
});

// ── 任务三：PnL 不阻塞持币复核 ───────────────────────────────────────

test('PnL 请求挂住 60 秒也不阻塞复核：卡片先出，随后原地补', async () => {
  const fomo = new FakeFomo();
  let release!: () => void;
  fomo.gate = new Promise<void>(r => { release = r; });          // 模拟 60 秒不返回
  const e = new Engine(fomo, new AbortController().signal, off);
  seedAlert('pending_recheck');
  const state = storedState(false);
  (e as any).collectStage = async () => stage(491, Date.now(), {}, 336);

  const t0 = Date.now();
  const outcome = await (e as any).attemptRecheck(state);
  const elapsed = Date.now() - t0;
  assert.equal(outcome, 'done');
  assert.ok(elapsed < 1_000, `复核不能等 PnL，实测 ${elapsed}ms`);

  const row = alertRow();
  assert.equal(row.status, 'completed', '复核照常完成');
  assert.equal(row.pnl_state, 'pending', 'PnL 另有生命周期');
  assert.match(lastCard()!.replace(/<[^>]+>/g, ''), /全平台24H PnL: 采集中…（0\/10）/);
  release();
});

test('同一条告警不会重复启动同一个取数任务，后来者等在跑的那个上', async () => {
  const fomo = new FakeFomo();
  let release!: () => void;
  fomo.gate = new Promise<void>(r => { release = r; });
  const e = new Engine(fomo, new AbortController().signal, off);
  const members = enriched().top10Members;
  const first = (e as any).runPnl('k1', members, DUE, 'prefetch');
  const second = (e as any).runPnl('k1', members, DUE, 'followup');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(fomo.calls.length, 1, '只能真的取一次');
  assert.equal(a, b, '第二个调用拿到的是同一批结果，而不是白白浪费一次尝试');
});

test('已撤回的告警不会被迟到的 PnL 结果重新更新', async () => {
  const fomo = new FakeFomo();
  const e = new Engine(fomo, new AbortController().signal, off);
  const state = storedState();
  // 告警已被复核门撤回 → alerts 里没有这一行
  const ok = await (e as any).applyPnl(state, { window: fomo.result.window, records: tenRecords(),
    members: state.recheck.e.top10Members, fetchedTs: Date.now() });
  assert.equal(ok, true, '这条 PnL 任务应当就此终结');
  assert.equal(edits().n, 0, '不能去改一条已经不存在的卡片');
});

test('消息 id 变了的告警也不会被迟到结果更新', async () => {
  const fomo = new FakeFomo();
  const e = new Engine(fomo, new AbortController().signal, off);
  seedAlert('completed', { pnl_state: 'pending' });
  db.prepare('UPDATE alerts SET message_id=? WHERE ca=?').run(9999, CA);
  const state = storedState();
  await (e as any).applyPnl(state, { window: fomo.result.window, records: tenRecords(),
    members: state.recheck.e.top10Members, fetchedTs: Date.now() });
  assert.equal(edits().n, 0);
});

test('成员变化时不沿用旧 Top10 的总和', async () => {
  const fomo = new FakeFomo();
  const e = new Engine(fomo, new AbortController().signal, off);
  seedAlert('completed', { pnl_state: 'pending' });
  const state = storedState();
  // 到期时的实际 Top10 里多了一个新人 u10：旧的十条记录覆盖不了它
  const stale = new Map(tenRecords());
  state.recheck.e.top10Members = [...state.recheck.e.top10Members.slice(0, 9),
    { rank: 10, userId: 'u10', handle: 'u10', evmAddress: null }];
  const ok = await (e as any).applyPnl(state, { window: fomo.result.window, records: stale,
    members: state.recheck.e.top10Members, fetchedTs: Date.now() });
  assert.equal(ok, false, '新增成员没取到就不能给合计，要留给下一次尝试');
  assert.equal(edits().n, 0);
});

test('中止信号下取数任务直接放弃，不再改写卡片', async () => {
  const fomo = new FakeFomo();
  const ac = new AbortController();
  ac.abort();
  const e = new Engine(fomo, ac.signal, off);
  seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: DUE + 600_000 });
  (e as any).startPnlFollowUp(storedState(), DUE + 600_000);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(fomo.calls.length, 0);
  assert.equal(edits().n, 0);
});

// ── 重启恢复 ─────────────────────────────────────────────────────────

test('重启恢复：只差 PnL 的告警在期限内接着补，不重发初值卡片', async () => {
  const fomo = new FakeFomo();
  const ac = new AbortController();
  const e = new Engine(fomo, ac.signal, off);
  seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: Date.now() + 600_000 });
  const r = e.resumePending();
  assert.equal(r.pnlResumed, 1);
  assert.equal(r.resumed, 0);
  await new Promise(res => setTimeout(res, 50));
  const sends = db.prepare("SELECT COUNT(*) n FROM notification_log WHERE op='send'").get() as any;
  assert.equal(sends.n, 0, '恢复流程绝不重发初值通知');
  assert.equal(edits().n, 1, '只做一次原地改写');
  assert.equal(alertRow().pnl_state, 'ready');
  ac.abort();
});

test('重启恢复：已过期的 PnL 任务终结为 timeout，不再堆积', () => {
  const fomo = new FakeFomo();
  const e = new Engine(fomo, new AbortController().signal, off);
  seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: Date.now() - 1 });
  const r = e.resumePending();
  assert.equal(r.pnlResumed, 0);
  assert.equal(alertRow().pnl_state, 'timeout');
  assert.equal(fomo.calls.length, 0);
});

test('重启恢复后时间语义不变：偏移仍由持币采集阶段决定', () => {
  const e = new Engine(new FakeFomo(), new AbortController().signal, off);
  seedAlert('pending_recheck');
  const stored = JSON.parse(alertRow().payload);
  const card = renderCard((e as any).buildCard(stored, 'ready'));
  assert.match(card, /持币初值（\+0\.8s）/);
  assert.match(card, /持币复核（\+5m1s）/);
});

test('旧版扁平 payload 也能恢复，且偏移按原值还原', () => {
  const e = new Engine(new FakeFomo(), new AbortController().signal, off);
  const legacy = JSON.stringify({
    m: market, triggerTs: TRIGGER, initialTotal: 178, initE: enriched(),
    initialOffsetMs: 800, messageId: 7, originalDueTs: DUE, recheckDueTs: DUE, attempts: 0,
  });
  db.prepare(`INSERT INTO alerts (ca,trigger_ts,message_id,payload,status,recheck_due_ts,original_due_ts,attempts,collection_state)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(CA, TRIGGER, 7, legacy, 'pending_recheck', DUE, DUE, 0, 'pending');
  const ac = new AbortController(); ac.abort();
  const r = new Engine(new FakeFomo(), ac.signal, off).resumePending();
  assert.equal(r.resumed, 1);
  assert.equal(r.corrupt, 0);
  void e;
});

// ── 补卡任务的截止时间 / 中止 / 异常 ─────────────────────────────────
// 回归：这三条以前只在**取数之前**检查一次。一次取数可能上百秒，回来之后
// 告警可能已经撤回、已经超期；而 notify.edit 抛异常会变成未处理的
// Promise rejection，在 Node 里直接结束整个监控进程。

/** 等到条件成立或超时，避免靠固定 sleep 猜时序 */
async function until(cond: () => boolean, ms = 2_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return cond();
}

test('取数期间超过截止时间：回来后不再改卡，终结为 timeout', async () => {
  const fomo = new FakeFomo();
  let release!: () => void;
  fomo.gate = new Promise<void>(r => { release = r; });
  const e = new Engine(fomo, new AbortController().signal, off);
  seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: Date.now() + 10_000 });

  // 截止时间设在「取数还没回来」的那一刻之前
  const deadline = Date.now() + 60;
  (e as any).startPnlFollowUp(storedState(), deadline);
  await new Promise(r => setTimeout(r, 120));      // 越过截止时间，此时取数仍挂着
  release();                                        // 取数现在才返回
  await until(() => alertRow().pnl_state === 'timeout');

  assert.equal(edits().n, 0, '超期之后拿到的结果不得再改写卡片');
  assert.equal(alertRow().pnl_state, 'timeout');
});

test('取数期间告警被撤回：回来后不改卡，也不写 timeout', async () => {
  const fomo = new FakeFomo();
  let release!: () => void;
  fomo.gate = new Promise<void>(r => { release = r; });
  const e = new Engine(fomo, new AbortController().signal, off);
  seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: Date.now() + 600_000 });

  (e as any).startPnlFollowUp(storedState(), Date.now() + 600_000);
  await new Promise(r => setTimeout(r, 30));
  // 取数还挂着的时候，这条告警被复核门撤回了
  (e as any).cancelPnl(`${CA}|${TRIGGER}`);
  db.prepare('DELETE FROM alerts WHERE ca=?').run(CA);
  release();
  await new Promise(r => setTimeout(r, 150));

  assert.equal(edits().n, 0, '不能去改一条已经撤回的卡片');
});

test('取数期间收到退出信号：不改卡，且保持 pending 供重启恢复', async () => {
  const fomo = new FakeFomo();
  let release!: () => void;
  fomo.gate = new Promise<void>(r => { release = r; });
  const ac = new AbortController();
  const e = new Engine(fomo, ac.signal, off);
  seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: Date.now() + 600_000 });

  (e as any).startPnlFollowUp(storedState(), Date.now() + 600_000);
  await new Promise(r => setTimeout(r, 30));
  ac.abort();                                       // 取数还挂着的时候退出
  release();
  await new Promise(r => setTimeout(r, 150));

  assert.equal(edits().n, 0);
  assert.equal(alertRow().pnl_state, 'pending', '中止不写终态，留给下次启动接着补');
});

test('notify.edit 抛异常不会变成未处理 rejection，任务正常终结', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const fomo = new FakeFomo();
    const boom = new Notifier('off');
    (boom as any).edit = async () => { throw new Error('改写炸了'); };
    const e = new Engine(fomo, new AbortController().signal, boom);
    seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: Date.now() + 600_000 });

    (e as any).startPnlFollowUp(storedState(), Date.now() + 600_000);
    // 两次尝试之间有 45s 退避，这里只验证第一次异常被接住、没有炸出去
    await new Promise(r => setTimeout(r, 200));
    await new Promise(r => setImmediate(r));

    assert.deepEqual(unhandled, [], `edit 抛异常不得逃逸成未处理 rejection：${unhandled.map(String)}`);
    assert.equal(alertRow().status, 'completed', '告警本身不受影响');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('改写失败时不留下「卡片没变、内存却当成已补上」的半截状态', async () => {
  const fomo = new FakeFomo();
  const boom = new Notifier('off');
  (boom as any).edit = async () => { throw new Error('改写炸了'); };
  const e = new Engine(fomo, new AbortController().signal, boom);
  seedAlert('completed', { pnl_state: 'pending', pnl_deadline_ts: Date.now() + 600_000 });
  const state = storedState();
  const before = state.recheck.e.top10PlatformPnl24h;

  await assert.rejects(() => (e as any).applyPnl(state, {
    window: fomo.result.window, records: tenRecords(),
    members: state.recheck.e.top10Members, fetchedTs: Date.now(),
  }), /改写炸了/);
  assert.equal(state.recheck.e.top10PlatformPnl24h, before, '改写没成功就不能改内存里的状态');
  assert.equal(alertRow().pnl_state, 'pending', '也不能写成 ready');
});
