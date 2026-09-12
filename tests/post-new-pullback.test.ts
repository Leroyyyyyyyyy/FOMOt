import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { runNewPullback, type NewPullbackConfig } from '../src/post/patterns/new-pullback.js';
import { runMillionReclaim, type MillionConfig } from '../src/post/patterns/million-reclaim.js';
import { POST_CONFIG_PATH } from '../src/post/config.js';
import { bars, TF1, BASE_TS } from './helpers/post-bars.js';

const root = parse(readFileSync(POST_CONFIG_PATH, 'utf8')) as any;
const cfg = root.new_pullback as NewPullbackConfig;
const mcfg = root.million_reclaim as MillionConfig;
const ctx = { firstTradeTs: BASE_TS, ageQuality: 'verified' as const };

/**
 * 合成 1m 序列（fixture，不是实测行情）。基准 B=100（前 5 根），
 * 拉到 200（2×）→ 跌到 170（-15%）→ 反弹到 192（收复 73%）
 * → 再跌到 165（-14%，D2/D1=0.97）→ 反弹到 185（收复 74%，距 D2 +12%）
 */
const HAPPY = [
  100, 100, 100, 100, 100,      // B = 100，第 5 根收盘后才可用
  120, 160, 200,                // H0 = 200 = 2×B
  185, 175, 170,                // 第一次回撤 -15%
  178, 186, 192,                // 反弹：距低点 +12.9%，收复 (192-170)/(200-170)=73%
  188, 180, 172, 165,           // 第二次回撤：峰值 192 → -14.1%
  172, 179, 185,                // 反弹：距低点 +12.1%，收复 (185-165)/(192-165)=74%
];

test('完整成功路径：两个独立周期顺序确认', () => {
  const r = runNewPullback(bars(HAPPY, TF1), cfg, ctx);
  assert.equal(r.phase, 'CONFIRMED', r.reason);
  assert.equal(r.baseline, 100);
  assert.equal(r.impulseHigh, 200);
  assert.equal(r.cycles.length, 2);
  assert.ok(r.cycles[1]!.lowTs > r.cycles[0]!.confirmedAt!, '第二轮低点必须晚于第一轮确认，不能复用');
  assert.equal(r.events.filter(e => e.type === 'NEW_PULLBACK_CONFIRMED').length, 1, '最多一张主卡');
  const snap = r.events[0]!.snapshot as any;
  assert.ok(snap.d2 >= snap.d1 * cfg.second_low_ratio_min);
  assert.ok(snap.invalidBelow < snap.d2, '失效参考价必须低于第二低点');
});

test('一路下跌不产生确认', () => {
  const r = runNewPullback(bars([100, 100, 100, 100, 100, 120, 160, 200, 180, 160, 140, 120, 100, 80], TF1), cfg, ctx);
  assert.notEqual(r.phase, 'CONFIRMED');
  assert.equal(r.events.length, 0);
});

test('连续两根红 K 不等于两次回撤', () => {
  // 只跌了 5%，够不上 12% 的 dip 门槛
  const r = runNewPullback(bars([100, 100, 100, 100, 100, 120, 160, 200, 196, 192, 196, 200], TF1), cfg, ctx);
  assert.equal(r.cycles.length, 0);
  assert.equal(r.events.length, 0);
});

test('回撤超过 45% → deep_dump 失效', () => {
  const r = runNewPullback(bars([100, 100, 100, 100, 100, 120, 160, 200, 150, 120, 100, 130], TF1), cfg, ctx);
  assert.equal(r.phase, 'DEEP_DUMP');
  assert.ok(r.evaluations.some(e => e.rule === 'new_pullback.deep_dump' && e.result === 'fail'));
});

test('第二次回拉距第二低点超过 25% → extended_rebound，不追价推确认', () => {
  // D2=165 之后一根直接拉到 215（+30%），第一次满足反弹确认时就已经超出 25%
  const seq = [...HAPPY.slice(0, 18), 172, 215];
  const r = runNewPullback(bars(seq, TF1), cfg, ctx);
  assert.equal(r.phase, 'EXTENDED_REBOUND');
  assert.equal(r.events.filter(e => e.type === 'NEW_PULLBACK_CONFIRMED').length, 0);
});

test('第二低点跌破第一低点的 90% → 不是「再跌再拉」，是继续下行', () => {
  const seq = [
    100, 100, 100, 100, 100, 120, 160, 200,
    185, 175, 170,
    178, 186, 192,
    180, 170, 160, 148,      // D2=148 < 170×0.90=153
    155, 165, 178,           // 收复 (178-148)/(192-148)=68%，够确认，但第二低点不合格
  ];
  const r = runNewPullback(bars(seq, TF1), cfg, ctx);
  assert.notEqual(r.phase, 'CONFIRMED');
  assert.ok(r.evaluations.some(e => e.rule === 'new_pullback.second_low' && e.result === 'fail'));
});

test('币龄证据不足时返回 age_unverified，不把老币重建池当新币', () => {
  const r = runNewPullback(bars(HAPPY, TF1), cfg, { firstTradeTs: BASE_TS, ageQuality: 'age_unverified' });
  assert.equal(r.phase, 'PENDING_HISTORY');
  assert.ok(r.evaluations.some(e => e.result === 'unknown' && e.reason.includes('age_unverified')));
});

test('发行早期段不够 → missing_launch_history，不拿被发现后的第一笔当发行价', () => {
  const r = runNewPullback(bars([100, 100, 200], TF1), cfg, ctx);
  assert.equal(r.phase, 'PENDING_HISTORY');
  assert.ok(r.evaluations.some(e => e.reason.includes('missing_launch_history')));
});

test('60 分钟内没有 2× 拉升 → NO_IMPULSE', () => {
  const flat = Array(70).fill(100).map((v, i) => (i < 5 ? 100 : 110));
  const r = runNewPullback(bars(flat, TF1), cfg, ctx);
  assert.equal(r.phase, 'NO_IMPULSE');
});

test('确认后 30 分钟内再跌 12% → 只发一次第三跌风险', () => {
  const seq = [...HAPPY, 180, 175, 160, 158];
  const r = runNewPullback(bars(seq, TF1), cfg, ctx);
  assert.equal(r.confirmedAt !== null, true);
  assert.equal(r.events.filter(e => e.type === 'THIRD_DIP_RISK').length, 1, '第三跌只提醒一次，不是新的入场条件');
});

test('跌破 D2×0.95 → 结构失效', () => {
  const seq = [...HAPPY, 170, 155];                     // D2=165，0.95×165=156.75
  const r = runNewPullback(bars(seq, TF1), cfg, ctx);
  assert.equal(r.phase, 'INVALIDATED');
  assert.equal(r.events.filter(e => e.type === 'STRUCTURE_INVALIDATED').length, 1);
});

test('数据缺口只标数据不可用，不当成风险解除', () => {
  const seq: any[] = [...HAPPY.map(c => ({ close: c })), { close: 0, kind: 'unknown' }];
  const r = runNewPullback(bars(seq, TF1), cfg, ctx);
  assert.ok(r.evaluations.some(e => e.rule === 'new_pullback.data' && e.result === 'unknown'));
  assert.equal(r.events.filter(e => e.type === 'STRUCTURE_INVALIDATED').length, 0);
});

test('重复跑结果一致', () => {
  const cs = bars(HAPPY, TF1);
  assert.deepEqual(runNewPullback(cs, cfg, ctx).events, runNewPullback(cs, cfg, ctx).events);
});

// ── 策略 C：百万关口 ────────────────────────────────────────────────────────

/** 带 FDV 的 1m 序列。价格与 FDV 同步，除非显式改供应量。 */
const withFdv = (rows: [number, number | null][]) =>
  bars(rows.map(([close, fdv]) => ({ close, fdv })), TF1);

test('关口成功路径：进入 1–2M → 回撤 15% → 两根同时创价格与 FDV 新高', () => {
  const r = runMillionReclaim(withFdv([
    [1.0, 900_000],                        // 关口以下
    [1.2, 1_200_000],                      // 进入关口
    [1.4, 1_400_000],
    [1.15, 1_150_000],                     // 从 1.4 回撤 17.9%
    [1.30, 1_300_000],
    [1.44, 1_440_000],                     // > 1.4×1.02
    [1.46, 1_460_000],
  ]), mcfg);
  assert.equal(r.phase, 'CONFIRMED', r.reason);
  assert.equal(r.events.filter(e => e.type === 'MILLION_RECLAIM_CONFIRMED').length, 1);
  assert.match((r.events[0]!.snapshot as any).note, /不要求确认时 FDV 仍 ≤2M/);
});

test('从 0.9M 一根跳到 2.5M → gate_skipped，不猜测中间已完成关口', () => {
  const r = runMillionReclaim(withFdv([[1.0, 900_000], [2.6, 2_500_000], [2.2, 2_100_000]]), mcfg);
  assert.equal(r.phase, 'GATE_SKIPPED');
  assert.equal(r.events.length, 0);
});

test('进入关口后 60 分钟内没有回撤 → gate 过期', () => {
  const rows: [number, number | null][] = [[1.0, 900_000]];
  for (let i = 0; i < 70; i++) rows.push([1.2 + i * 0.001, 1_200_000 + i * 1000]);
  const r = runMillionReclaim(withFdv(rows), mcfg);
  assert.equal(r.phase, 'GATE_EXPIRED');
});

test('慢回收（超过 30 分钟）不触发', () => {
  const rows: [number, number | null][] = [[1.0, 900_000], [1.4, 1_400_000], [1.15, 1_150_000]];
  for (let i = 0; i < 35; i++) rows.push([1.2, 1_200_000]);
  rows.push([1.5, 1_500_000], [1.52, 1_520_000]);
  const r = runMillionReclaim(withFdv(rows), mcfg);
  assert.equal(r.phase, 'RECOVERY_TIMEOUT');
});

test('只有 FDV 新高、价格没有新高 → 供应量变化，不算收复新高', () => {
  const r = runMillionReclaim(withFdv([
    [1.0, 900_000], [1.4, 1_400_000], [1.15, 1_150_000],
    [1.30, 3_000_000], [1.31, 3_100_000],     // FDV 因增发翻倍，价格仍低于峰值
  ]), mcfg);
  assert.notEqual(r.phase, 'CONFIRMED');
  assert.equal(r.events.length, 0);
});

test('没有时点 FDV 就不触发，也不猜', () => {
  const r = runMillionReclaim(withFdv([[1.0, null], [1.4, null], [1.15, null], [1.5, null], [1.52, null]]), mcfg);
  assert.equal(r.phase, 'NO_FDV');
  assert.ok(r.evaluations.every(e => e.result === 'unknown'));
});

test('触发后 30 分钟内跌回本次回调低点之下 → 失效', () => {
  const r = runMillionReclaim(withFdv([
    [1.0, 900_000], [1.2, 1_200_000], [1.4, 1_400_000],
    [1.15, 1_150_000], [1.44, 1_440_000], [1.46, 1_460_000],
    [1.10, 1_100_000],
  ]), mcfg);
  assert.equal(r.phase, 'INVALIDATED');
  assert.equal(r.events.filter(e => e.type === 'MILLION_RECLAIM_INVALIDATED').length, 1);
});
