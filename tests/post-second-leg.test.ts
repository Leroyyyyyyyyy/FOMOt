import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { runSecondLeg, buildBox, countZoneVisits, type SecondLegConfig } from '../src/post/patterns/second-leg.js';
import { POST_CONFIG_PATH } from '../src/post/config.js';
import { bars, ramp, oscillate, TF15 } from './helpers/post-bars.js';

const cfg = (parse(readFileSync(POST_CONFIG_PATH, 'utf8')) as any).second_leg as SecondLegConfig;
const BARS_PER_HOUR = 4;                                   // 15m
const h = (n: number) => n * BARS_PER_HOUR;

/**
 * 一段可手算复核的合成序列（fixture，不是实测行情）：
 *   4 根底部 100 → 8 根拉到 300（3×，2h，≤24h）
 *   → 回撤到 200（-33%，先确认高点再越过 25% 门槛）
 *   → 之后在 [180, 240] 之间横盘，中位约 210，宽度 ≈ 0.286
 */
function scenario(rangeHours: number, opts: { boxLo?: number; boxHi?: number; tail?: number[] } = {}) {
  const lo = opts.boxLo ?? 180, hi = opts.boxHi ?? 240;
  const seq: (number | any)[] = [
    ...Array(4).fill(100),
    ...ramp(120, 300, 8),
    240,                                                   // -20%：确认高点 300
    200,                                                   // -33%：越过 25% 门槛 → rangeStartTs
    ...oscillate(lo, hi, h(rangeHours), 16),
    ...(opts.tail ?? []),
  ];
  return bars(seq, TF15);
}

test('完整成功路径：第一波 3× → 回撤 33% → 箱体 → 48h 后发 READY', () => {
  const r = runSecondLeg(scenario(50), cfg);
  assert.equal(r.phase, 'READY', r.reason);
  assert.ok(r.firstLeg, '必须识别出第一波');
  assert.equal(r.firstLeg!.highPrice, 300);
  assert.equal(r.firstLeg!.lowPrice, 100);
  assert.ok(r.firstLeg!.multiple >= 2);
  assert.ok(r.box, '必须冻结箱体');
  assert.ok(r.box!.width >= cfg.box_width_min && r.box!.width <= cfg.box_width_max, `宽度 ${r.box!.width}`);
  assert.ok(r.zoneVisits >= cfg.zone_visits_min, `区域往返 ${r.zoneVisits}`);
  const ready = r.events.filter(e => e.type === 'SECOND_LEG_READY');
  assert.equal(ready.length, 1, 'READY 只发一次');
  assert.ok((ready[0]!.snapshot as any).expiresAt > (ready[0]!.snapshot as any).rangeStartTs);
});

test('24–48h 的合格箱体只在本地观察，不发 TG', () => {
  const r = runSecondLeg(scenario(40), cfg);
  assert.equal(r.phase, 'RANGE_TRACKING');
  assert.equal(r.events.length, 0, '未满 48h 不得产生任何待发事件');
  assert.match(r.reason, /未到 48h/);
});

test('没有第一波时不能只看横盘就认定二段', () => {
  const r = runSecondLeg(bars(oscillate(180, 240, h(60), 16), TF15), cfg);
  assert.equal(r.phase, 'FIRST_LEG_TRACKING');
  assert.equal(r.firstLeg, null);
  assert.equal(r.events.length, 0);
  assert.ok(r.evaluations.some(e => e.reason.includes('missing_first_leg')));
});

test('第一波后跌 85% 再横盘 → 拒绝，不做「归零反弹二段」', () => {
  const seq = [
    ...Array(4).fill(100),
    ...ramp(120, 300, 8),
    240, 200,                       // 确认高点并越过 25%
    45,                             // 距高点 -85%，close ≤ 300×0.20
    ...oscillate(40, 50, h(60), 16),
  ];
  const r = runSecondLeg(bars(seq, TF15), cfg);
  assert.equal(r.phase, 'INVALIDATED');
  assert.match(r.reason, /深跌排除/);
  assert.equal(r.events.filter(e => e.type === 'SECOND_LEG_READY').length, 0);
});

test('建箱 24h 里持续缓跌 → 按日漂移拒绝，不是横盘', () => {
  const seq = [
    ...Array(4).fill(100), ...ramp(120, 300, 8), 240, 200,
    ...ramp(200, 120, h(30)),       // 24h 内一路下滑
  ];
  const r = runSecondLeg(bars(seq, TF15), cfg);
  assert.equal(r.phase, 'RANGE_REJECTED');
  assert.match(r.reason, /日漂移|宽度/);
});

test('建箱 24h 里真实成交桶不足 70% → 拒绝「几乎没交易的平线」', () => {
  const box = oscillate(180, 240, h(30), 16).map((c, i) =>
    i % 2 === 0 ? { close: c, kind: 'synthetic' as const } : { close: c });
  const r = runSecondLeg(bars([...Array(4).fill(100), ...ramp(120, 300, 8), 240, 200, ...box], TF15), cfg);
  assert.equal(r.phase, 'RANGE_REJECTED');
  assert.match(r.reason, /真实成交桶/);
});

test('建箱窗口里有缺口桶 → 数据不完整，不能拿残缺数据建箱', () => {
  const box = oscillate(180, 240, h(30), 16).map((c, i) =>
    i === 10 ? { close: 0, kind: 'unknown' as const } : { close: c });
  const r = runSecondLeg(bars([...Array(4).fill(100), ...ramp(120, 300, 8), 240, 200, ...box], TF15), cfg);
  assert.equal(r.phase, 'RANGE_REJECTED');
  assert.match(r.reason, /缺口|未扫描/);
  assert.ok(r.evaluations.some(e => e.result === 'unknown'), '数据不完整必须记 unknown 而不是 fail');
});

/**
 * 箱体上下沿是 Q10/Q90，不是构造序列的 180/240，所以破位/突破类的尾部
 * 必须按**冻结后的真实箱体**构造。先跑一次拿到 box，再拼尾部重跑。
 */
function withTail(rangeHours: number, tailOf: (box: { lower: number; upper: number; mid: number }) => number[]) {
  const base = runSecondLeg(scenario(rangeHours), cfg);
  assert.ok(base.box, `基线必须先冻结箱体：${base.reason}`);
  return runSecondLeg(scenario(rangeHours, { tail: tailOf(base.box!) }), cfg);
}

test('允许范围内的短破位等待收回；收回前不发确认', () => {
  // 跌破箱底但 ≥0.92×Lbox，连续 2 根，随后收回
  const r = withTail(49, b => [b.lower * 0.95, b.lower * 0.95, b.mid]);
  assert.notEqual(r.phase, 'INVALIDATED', `短破位后收回不应失效：${r.reason}`);
  assert.equal(r.reclaimPending, false, '收回后应解除 reclaim_pending');
});

test('连续 3 根收盘跌破箱底 → 失效一次', () => {
  const r = withTail(49, b => [b.lower * 0.95, b.lower * 0.95, b.lower * 0.95]);
  assert.equal(r.phase, 'INVALIDATED');
  assert.match(r.reason, /连续 3 根/);
  assert.equal(r.events.filter(e => e.type === 'SECOND_LEG_INVALIDATED').length, 1, '失效只发一次');
});

test('close 跌破 0.92×箱底 → 立刻失效，不进短破位宽限', () => {
  const r = withTail(49, b => [b.lower * 0.90]);
  assert.equal(r.phase, 'INVALIDATED');
  assert.match(r.reason, /容忍线/);
});

test('单根影线或单根 close 越过箱顶都不算突破，连续两根才算', () => {
  const one = withTail(50, b => [b.upper * 1.05, b.mid]);
  assert.equal(one.breakoutAt, null, '单根 close 不能确认突破');
  const two = withTail(50, b => [b.upper * 1.05, b.upper * 1.06]);
  assert.equal(two.phase, 'BREAKOUT_CONFIRMED', two.reason);
  assert.equal(two.events.filter(e => e.type === 'SECOND_LEG_BREAKOUT').length, 1);
});

test('48h 以前就突破只记 early_breakout，不伪装成熟二段', () => {
  const r = withTail(30, b => [b.upper * 1.05, b.upper * 1.06, b.upper * 1.06, b.upper * 1.06]);
  assert.equal(r.earlyBreakout, true);
  assert.equal(r.breakoutAt, null);
  assert.equal(r.events.filter(e => e.type === 'SECOND_LEG_BREAKOUT').length, 0);
});

test('超过 96h 未突破 → EXPIRED；箱体时钟不因来回小破位重启', () => {
  const r = runSecondLeg(scenario(100), cfg);
  assert.equal(r.phase, 'EXPIRED');
  assert.ok(r.rangeAgeHours! > cfg.ready_max_hours);
  assert.equal(r.events.filter(e => e.type === 'SECOND_LEG_EXPIRED').length, 1);
});

test('突破的两根确认完成时已超过 96h → 只记过期，不追溯成有效二段', () => {
  const r = withTail(97, b => [b.upper * 1.05, b.upper * 1.06]);
  assert.equal(r.phase, 'EXPIRED');
  assert.equal(r.events.filter(e => e.type === 'SECOND_LEG_BREAKOUT').length, 0);
});

test('突破后连续两根跌回箱顶之下 → BREAKOUT_FAILED，失败样本不撤回', () => {
  const r = withTail(50, b => [b.upper * 1.05, b.upper * 1.06, b.upper * 0.98, b.upper * 0.97]);
  assert.equal(r.events.filter(e => e.type === 'BREAKOUT_FAILED').length, 1);
  assert.equal(r.events.filter(e => e.type === 'SECOND_LEG_BREAKOUT').length, 1, '突破事件仍然保留');
});

test('47h59m 不发、48h 发——边界按 §6.4', () => {
  const justBefore = runSecondLeg(scenario(47.75), cfg);
  assert.equal(justBefore.events.filter(e => e.type === 'SECOND_LEG_READY').length, 0);
  const atBoundary = runSecondLeg(scenario(48.25), cfg);
  assert.equal(atBoundary.events.filter(e => e.type === 'SECOND_LEG_READY').length, 1);
});

test('同一段数据重复跑结果完全一致（不二次计数 pivot、不重复建箱）', () => {
  const cs = scenario(50);
  const a = runSecondLeg(cs, cfg);
  const b = runSecondLeg(cs, cfg);
  assert.deepEqual(b.events, a.events);
  assert.deepEqual(b.box, a.box);
  assert.equal(b.readyAt, a.readyAt);
});

test('逐步截断到每个 asOf 再跑，结果与逐桶推进一致（无前视）', () => {
  const cs = scenario(50);
  let firstReadyAt: number | null = null;
  for (let n = 1; n <= cs.length; n++) {
    const r = runSecondLeg(cs.slice(0, n), cfg);
    if (r.readyAt !== null) { firstReadyAt = r.readyAt; break; }
  }
  assert.equal(firstReadyAt, runSecondLeg(cs, cfg).readyAt,
    '截断回放得到的首次 READY 时间必须与整段一致');
});

test('箱体统计口径固定：Q10/Q90/median 与日漂移可手算复核', () => {
  const cs = bars([100, 110, 120, 130, 140], TF15);
  const box = buildBox(cs, cs[0]!.closeTs, cfg)!;
  assert.equal(box.mid, 120);
  assert.ok(Math.abs(box.lower - 104) < 1e-9, `Q10 应为 104，实际 ${box.lower}`);
  assert.ok(Math.abs(box.upper - 136) < 1e-9, `Q90 应为 136，实际 ${box.upper}`);
  assert.ok(Math.abs(box.width - 32 / 120) < 1e-9);
});

test('区域往返：同一区连续多根只算一次，跨区太快不算', () => {
  const box = { lower: 100, upper: 200, mid: 150, width: 0.66, slope24h: 0, realBarRatio: 1, builtAt: 0, bars: 0 };
  const c = { ...cfg, zone_gap_bars_min: 4, zone_fraction: 0.25 };
  // 下区连续 5 根 → 只算 1 次
  assert.equal(countZoneVisits(bars(Array(5).fill(110), TF15), box, c), 1);
  // 下 → 上但只隔 1 根 → 不计
  assert.equal(countZoneVisits(bars([110, 190], TF15), box, c), 1);
  // 下 → (间隔 4 根) → 上 → (间隔 4 根) → 下 = 3 次
  assert.equal(countZoneVisits(bars([110, 150, 150, 150, 190, 150, 150, 150, 110], TF15), box, c), 3);
});
