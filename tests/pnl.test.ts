import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePnl, anchorWindow, bestAnchor, deriveRecord, isDayWindow, normalizeSeries,
  strictNum, targetWindow, usableAnchor, DAY_MS, HOUR_MS, type PnlRecord, type PnlWindow,
} from '../src/engine/pnl.js';

const END = Math.floor(1_760_000_000_000 / HOUR_MS) * HOUR_MS;   // 某个整点
const W: PnlWindow = { basis: 'snapshot', startTs: END - DAY_MS, endTs: END };

/** 生成一条逐小时累计序列：pnl 从 0 起每小时 +step。 */
function series(endTs = END, hours = 30, step = 100): { snapshotId: number; pnl: number }[] {
  const out = [];
  for (let i = hours; i >= 0; i--) {
    const ts = endTs - i * HOUR_MS;
    out.push({ snapshotId: ts / 1000, pnl: (hours - i) * step });
  }
  return out;
}

const rec = (userId: string, value: number, over: Partial<PnlRecord> = {}): PnlRecord => ({
  userId, value, source: 'aggregated_snapshot', basis: 'snapshot',
  windowStartTs: W.startTs, windowEndTs: W.endTs, fetchedTs: END + 5 * 60_000, ...over,
});

// ── 目标窗口 ─────────────────────────────────────────────────────────

test('目标窗口对齐整点、恰好 24 小时，同一次聚合只算一次', () => {
  const w = targetWindow(END + 17 * 60_000 + 123);
  assert.equal(w.endTs, END, '取整到整点，不是「刚抓到的那一刻」');
  assert.equal(w.endTs - w.startTs, DAY_MS);
  assert.ok(isDayWindow(w));
  // 同一次聚合内即使时钟走过了几十分钟，只要用同一个 atMs 就得到同一个窗口
  assert.deepEqual(targetWindow(END + 59 * 60_000), w);
  // 跨过整点就是**另一个**窗口——正因如此才不能各自去挑「最新点」
  assert.notDeepEqual(targetWindow(END + HOUR_MS), w);
});

test('25 小时的区间不是 24H，isDayWindow 直接拒掉', () => {
  assert.equal(isDayWindow({ basis: 'snapshot', startTs: END - DAY_MS - HOUR_MS, endTs: END }), false);
  assert.equal(isDayWindow({ basis: 'snapshot', startTs: END - DAY_MS + 1, endTs: END + 1 }), false, '不在整点上');
});

// ── 序列校验 ─────────────────────────────────────────────────────────

test('序列乱序也能正确排序求差', () => {
  const shuffled = [...series()].reverse();
  const r = deriveRecord('u1', shuffled, W, 1);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.record.value, 24 * 100, '24 小时 = 24 个 step');
});

test('同一整点出现冲突数值时整条序列不可用', () => {
  const raw = series();
  raw.push({ snapshotId: END / 1000, pnl: 999_999 });        // 同一个整点，另一个值
  const n = normalizeSeries(raw);
  assert.equal(n.conflict, true);
  const r = deriveRecord('u1', raw, W, 1);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'conflicting_points');
});

test('重复但数值相同只算一次，不算冲突', () => {
  const raw = [...series(), { snapshotId: END / 1000, pnl: 30 * 100 }];
  const n = normalizeSeries(raw);
  assert.equal(n.conflict, false);
  assert.equal(n.points.filter(p => p.snapshotId === END / 1000).length, 1);
});

// ── 空值绝不当成 0 ───────────────────────────────────────────────────
// 回归：以前用 Number(v)，而 Number(null)/Number('')/Number('  ')/Number([])
// 全是 0、Number(true) 是 1，都能通过 isFinite 检查。于是「起点 pnl 是 null」
// 会被当成「起点收益 0」，凭空算出一个 24H 收益。

test('strictNum：空值、布尔、数组、对象一律是缺失，不是 0', () => {
  assert.equal(strictNum(0), 0, '真正的 0 要保留');
  assert.equal(strictNum(-12.5), -12.5);
  assert.equal(strictNum('42'), 42, '数字字符串可以');
  assert.equal(strictNum(' -3.5 '), -3.5);
  for (const v of [null, undefined, '', '   ', true, false, [], {}, 'abc', NaN, Infinity]) {
    assert.equal(strictNum(v as unknown), null, `${JSON.stringify(v)} 必须判成缺失`);
  }
});

test('端点 pnl 是 null 时判缺失，不会算出收益', () => {
  // 这是复现用例：起点 null、终点 100 —— 旧代码会返回 ok:true, value:100
  const raw = [
    { snapshotId: W.startTs / 1000, pnl: null },
    { snapshotId: W.endTs / 1000, pnl: 100 },
  ];
  const r = deriveRecord('u1', raw, W, 1);
  assert.equal(r.ok, false, 'null 起点不能当成 0 起点');
  assert.equal(!r.ok && r.reason, 'no_start_point');
});

test('空字符串 / 布尔 / 数组的 pnl 都被剔除，不参与任何计算', () => {
  for (const bad of ['', '   ', true, [] as unknown]) {
    const n = normalizeSeries([{ snapshotId: END / 1000, pnl: bad }]);
    assert.equal(n.points.length, 0, `pnl=${JSON.stringify(bad)} 不该产生数据点`);
    assert.equal(n.dropped, 1);
  }
});

test('snapshotId 是 null 时不会退化成 snapshotId 0', () => {
  const n = normalizeSeries([{ snapshotId: null, pnl: 5 }]);
  assert.equal(n.points.length, 0, 'null 的整点不能变成 1970 年那个整点');
  assert.equal(n.dropped, 1);
});

test('十人里有一人端点是空值：合计判缺失，不是把他算成 0', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `u${i}`);
  const records = new Map<string, PnlRecord>();
  ids.forEach((id, i) => {
    const raw = [
      { snapshotId: W.startTs / 1000, pnl: i === 4 ? '' : 0 },   // 第五个人起点是空字符串
      { snapshotId: W.endTs / 1000, pnl: 100 },
    ];
    const r = deriveRecord(id, raw, W, END + 60_000);
    if (r.ok) records.set(id, r.record);
  });
  assert.equal(records.size, 9, '空值那个人拿不到记录');
  const agg = aggregatePnl(ids, records, END + 60_000);
  assert.equal(agg.total, null, '缺一个人就不给合计，绝不把他当成 +100');
  assert.equal(agg.covered, 9);
});

test('非有限数值被剔除；影响到端点就报缺失，绝不当成 0', () => {
  const raw = series().map(p => p.snapshotId === END / 1000 ? { ...p, pnl: NaN } : p);
  const n = normalizeSeries(raw);
  assert.equal(n.dropped, 1);
  const r = deriveRecord('u1', raw, W, 1);
  assert.equal(!r.ok && r.reason, 'no_end_point', '端点被剔除后就是缺终点，不是收益为 0');
});

test('历史起点缺失、只有更早的点时不生成 24H 值', () => {
  // 去掉精确的起点，只留下 25 小时前那个点
  const raw = series().filter(p => p.snapshotId !== W.startTs / 1000);
  assert.ok(raw.some(p => p.snapshotId < W.startTs / 1000), '更早的点确实还在');
  const r = deriveRecord('u1', raw, W, 1);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'no_start_point', '不能拿更早的点凑一个 25 小时区间');
});

test('序列为空 / 终点不存在都各有原因', () => {
  assert.equal(deriveRecord('u1', [], W, 1).ok, false);
  const early = series(END - HOUR_MS);                      // 最新点只到上一个整点
  const r = deriveRecord('u1', early, W, 1);
  assert.equal(!r.ok && r.reason, 'no_end_point');
});

test('锚点最多往前退一个整点，退不到就返回 null', () => {
  assert.deepEqual(anchorWindow(series(END - HOUR_MS), END), {
    basis: 'snapshot', startTs: END - HOUR_MS - DAY_MS, endTs: END - HOUR_MS,
  });
  assert.equal(anchorWindow(series(END - 3 * HOUR_MS), END), null, '退两个小时以上就不是同一次聚合的窗口');
  assert.equal(anchorWindow([], END), null);
});

// ── 缓存锚点（跨整点复用的第一道闸） ─────────────────────────────────

const winAt = (endTs: number): PnlWindow => ({ basis: 'snapshot', startTs: endTs - DAY_MS, endTs });

test('缓存窗口只有落在目标整点的一小时内才能复用', () => {
  assert.equal(usableAnchor(winAt(END), END), true, '正好是目标整点');
  assert.equal(usableAnchor(winAt(END - HOUR_MS), END), true, '早一个整点：还能整批共用');
  assert.equal(usableAnchor(winAt(END - 2 * HOUR_MS), END), false, '早两个整点：不是同一次聚合的窗口');
  assert.equal(usableAnchor(winAt(END + HOUR_MS), END), false, '晚于目标整点不能用');
  assert.equal(usableAnchor({ basis: 'live', startTs: END - DAY_MS, endTs: END }, END), false, '口径不同不能当锚');
  assert.equal(usableAnchor({ basis: 'snapshot', startTs: END - DAY_MS - HOUR_MS, endTs: END }, END), false,
    '25 小时的区间不能当 24H 的锚');
});

test('跨整点后旧缓存挑不出锚点，只能现取', () => {
  // 上一小时缓存满命中，但目标整点已经往前走了两小时
  const stale = [{ window: winAt(END - 2 * HOUR_MS), hits: 10 }];
  assert.equal(bestAnchor(stale, END), null, '宁可现取，也不拿旧窗口凑总和');
});

test('多个可用窗口时取最新的；一样新才比命中数', () => {
  const a = { window: winAt(END - HOUR_MS), hits: 9 };
  const b = { window: winAt(END), hits: 1 };
  assert.deepEqual(bestAnchor([a, b], END), b.window, '最新的优先，哪怕命中少');
  const c = { window: winAt(END), hits: 5 };
  assert.deepEqual(bestAnchor([b, c], END), c.window, '一样新时命中多的优先');
  assert.equal(bestAnchor([], END), null);
});

// ── 聚合校验 ─────────────────────────────────────────────────────────

const ids = Array.from({ length: 10 }, (_, i) => `u${i}`);

test('十人同窗口：正确求和，盈利人数按本口径统计', () => {
  const records = new Map(ids.map((id, i) => [id, rec(id, i === 0 ? -50 : 10)]));
  const agg = aggregatePnl(ids, records, END + 60_000);
  assert.equal(agg.total, 9 * 10 - 50);
  assert.equal(agg.profitable, 9);
  assert.equal(agg.covered, 10);
  assert.equal(agg.reason, null);
  assert.deepEqual(agg.window, W);
});

test('都是 snapshot，但一人结束时间不同：拒绝合计', () => {
  const records = new Map(ids.map((id, i) => [id,
    i === 3 ? rec(id, 10, { windowStartTs: W.startTs - HOUR_MS, windowEndTs: W.endTs - HOUR_MS }) : rec(id, 10)]));
  const agg = aggregatePnl(ids, records, END + 60_000);
  assert.equal(agg.total, null);
  assert.equal(agg.profitable, null);
  assert.equal(agg.covered, 10, '人齐了，但窗口不齐');
  assert.match(agg.reason!, /窗口起止时间不一致/);
});

test('跨整点命中旧缓存：旧窗口的记录不能和新窗口的混算', () => {
  const prevHour = { windowStartTs: W.startTs - HOUR_MS, windowEndTs: W.endTs - HOUR_MS };
  const records = new Map(ids.map((id, i) => [id,
    i < 4 ? rec(id, 10, prevHour) : rec(id, 10)]));
  const agg = aggregatePnl(ids, records, END + 60_000);
  assert.equal(agg.total, null);
  assert.match(agg.reason!, /窗口起止时间不一致/);
});

test('实时口径与整点口径混在一起时拒绝求和', () => {
  const records = new Map(ids.map((id, i) => [id,
    i === 0 ? rec(id, 10, { basis: 'live', source: 'leaderboard_24h' }) : rec(id, 10)]));
  const agg = aggregatePnl(ids, records, END + 60_000);
  assert.equal(agg.total, null);
  assert.match(agg.reason!, /口径不一致/);
});

test('九人齐全、一人缺失：n/a 且覆盖率是 9/10', () => {
  const records = new Map(ids.slice(0, 9).map(id => [id, rec(id, 10)]));
  const agg = aggregatePnl(ids, records, END + 60_000);
  assert.equal(agg.total, null);
  assert.equal(agg.profitable, null);
  assert.equal(agg.covered, 9);
  assert.equal(agg.expected, 10);
  assert.match(agg.reason!, /缺 1 人/);
});

test('成员没有 userId 时如实计入缺失，不被悄悄跳过', () => {
  const members = [...ids.slice(0, 9), null];
  const records = new Map(ids.slice(0, 9).map(id => [id, rec(id, 10)]));
  const agg = aggregatePnl(members, records, END + 60_000);
  assert.equal(agg.total, null);
  assert.equal(agg.expected, 10);
  assert.match(agg.reason!, /无 userId/);
});

test('非有限数值不参与求和', () => {
  const records = new Map(ids.map((id, i) => [id, rec(id, i === 2 ? Number.POSITIVE_INFINITY : 10)]));
  const agg = aggregatePnl(ids, records, END + 60_000);
  assert.equal(agg.total, null);
  assert.match(agg.reason!, /非有限/);
});

test('窗口过期（右端离现在超过两小时）不给合计', () => {
  const records = new Map(ids.map(id => [id, rec(id, 10)]));
  const agg = aggregatePnl(ids, records, END + 3 * HOUR_MS);
  assert.equal(agg.total, null);
  assert.match(agg.reason!, /窗口已过期/);
});

test('空成员集合有自己的缺失原因', () => {
  const agg = aggregatePnl([], new Map(), END);
  assert.equal(agg.total, null);
  assert.equal(agg.expected, 0);
  assert.match(agg.reason!, /集合为空/);
});

test('获取时间与窗口结束时间是两个字段', () => {
  const r = deriveRecord('u1', series(), W, END + 18 * 60_000);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.record.windowEndTs, END, '窗口右端是整点');
    assert.equal(r.record.fetchedTs, END + 18 * 60_000, '获取时间是我们真正拿到数据的时刻');
    assert.notEqual(r.record.windowEndTs, r.record.fetchedTs);
  }
});

// ── 端到端可追溯样例 ─────────────────────────────────────────────────
// 与 scripts/trace-pnl.ts 同一组输入：逐人序列 → 窗口校验 → 合计/盈利人数 → 渲染。
// 任何一环改了口径，这条都会红。

test('逐人输入 → 窗口校验 → 合计与盈利人数 → 渲染，全链路可复算', async () => {
  const { enrichSocial } = await import('../src/engine/enrich.js');
  const { renderCard } = await import('../src/notify/render.js');

  // 十个人的 24H 收益：正 7、零 1、负 2
  const values = [500_000, 120_000, -52_360, 0, 30_000, 10, -3, 7_000, 2_500, 1];
  const records = new Map(values.map((v, i) => {
    // 每人一条真序列，收益由两端相减得到——不是直接塞一个数
    const raw = Array.from({ length: 31 }, (_, k) => {
      const ts = END - (30 - k) * HOUR_MS;
      return { snapshotId: ts / 1000, pnl: ts === END ? 1_000 + v : 1_000 };
    });
    const r = deriveRecord(`u${i}`, raw, W, END + 41_000);
    assert.ok(r.ok, `u${i} 应能推出记录`);
    assert.equal(r.ok && r.record.value, v);
    return [`u${i}`, (r as { ok: true; record: PnlRecord }).record];
  }));

  const agg = aggregatePnl(values.map((_, i) => `u${i}`), records, END + 60_000);
  assert.equal(agg.total, 607_148, '手工合计：500000+120000-52360+0+30000+10-3+7000+2500+1');
  assert.equal(agg.profitable, 7, '零收益不算盈利，两个负数也不算');

  const top = values.map((_, i) => ({
    rank: i + 1, userId: `u${i}`, handle: `h${i}`,
    evmAddress: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    followers: 1, amount: 100 - i, pnl: 100 * (i + 1), isDev: false,
  }));
  const snap = {
    ca: '0x' + 'ab'.repeat(20), total: 491, top: [],
    balances: new Map<string, bigint>(), atBlock: 1n, atBlockHash: null,
    blockTs: END, takenTs: END, scannedBlocks: 1, rebuilt: false, latencyMs: 1,
  } as any;
  const e = enrichSocial(18, snap, { fomoHolders: 336, top, freshMs: 0, takenTs: END, ingestMs: 64 } as any,
    [], true, new Map(), records, END + 60_000);
  assert.equal(e.top10PlatformPnl24h, 607_148);
  assert.equal(e.top10PlatformProfitable24h, 7);
  // 该币累计收益是**另一个量**：100+200+…+1000 = 5500，盈利 10 人
  assert.equal(e.top10TokenPnl, 5_500);
  assert.equal(e.top10TokenProfitable, 10);

  const card = renderCard({
    ca: snap.ca, symbol: 'MEME', name: 'M', marketCapUsd: 1, triggerTs: END,
    volume5m: 1, volume1h: 1,
    initial: { total: 178, fomo: 72, offsetMs: 800 },
    recheck: { total: 491, fomo: 336, offsetMs: 301_000 },
    leaderboardHolders: [], leaderboardAvailable: true, leaderboardPartial: false,
    top10: {
      tokenPnlTotal: e.top10TokenPnl, tokenPnlCovered: e.top10TokenPnlCovered,
      tokenProfitable: e.top10TokenProfitable,
      platformPnl24h: e.top10PlatformPnl24h, platformProfitable: e.top10PlatformProfitable24h,
      platformCovered: e.top10PlatformCovered, platformWindow: e.top10PlatformWindow,
      platformFetchedTs: e.top10PlatformFetchedTs, platformState: 'ready', platformReason: null,
      identified: e.identified, count: e.top10Count, offsetMs: 301_000,
    },
    sources: { chainBlock: '1', chainBlockTs: END, chainTakenTs: END, fomoRespTs: END,
      boardTakenTs: null, marketTakenTs: END, sourceSkewMs: 0, degraded: [] },
    health: { sourceOk: true, holderCoverage: [10, 336], ingestMs: 64, notifyMode: 'off' },
  }).replace(/<[^>]+>/g, '');

  assert.match(card, /该币累计收益（已实现\+未实现）: \+\$5\.50K · 盈利 10 人/);
  assert.match(card, /全平台24H PnL: \+\$607\.15K · 盈利 7 人 · 整点对齐口径/);
  const platLine = card.split('\n').find(l => l.includes('全平台24H PnL'))!;
  assert.ok(!platLine.includes('10 人'), '两行的盈利人数不得互相顶替');
});
