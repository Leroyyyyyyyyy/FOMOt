import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { computeRsi, smoothSeries, rsiFromCandles, detectOverheat, type RsiConfig } from '../src/post/patterns/rsi.js';
import { POST_CONFIG_PATH, VERSIONED_DEFAULTS } from '../src/post/config.js';
import { bars, TF1 } from './helpers/post-bars.js';

const cfg = (parse(readFileSync(POST_CONFIG_PATH, 'utf8')) as any).rsi as RsiConfig;

test('单调上涨 → avgLoss=0 → RSI=100', () => {
  const r = computeRsi(Array.from({ length: 20 }, (_, i) => 100 + i), 9);
  assert.equal(r[9], 100);
  assert.equal(r[19], 100);
});

test('单调下跌 → avgGain=0 → RSI=0', () => {
  const r = computeRsi(Array.from({ length: 20 }, (_, i) => 100 - i), 9);
  assert.equal(r[19], 0);
});

test('完全平 → 两者均为 0 → 返回本项目约定的 50', () => {
  const r = computeRsi(Array(20).fill(100), 9);
  assert.equal(r[19], VERSIONED_DEFAULTS.rsiFlatValue);
  assert.equal(r[19], 50);
});

test('前 10 根连续 close 才有第一个 RSI（n=9 需要 n+1 个价）', () => {
  const r = computeRsi([1, 2, 3, 4, 5, 6, 7, 8, 9], 9);
  assert.ok(r.every(v => v === null), '只有 9 个 close 时一个 RSI 都算不出来');
  const r2 = computeRsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 9);
  assert.equal(r2[8], null);
  assert.equal(r2[9], 100, '第 10 个 close 才产生第一个 RSI');
});

test('Wilder RMA 递推可手算复核', () => {
  // 前 9 个 delta：8 个 +1、1 个 -1 → avgGain=8/9, avgLoss=1/9 → RSI=100-100/(1+8)=88.888…
  const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 17];
  const r = computeRsi(closes, 9);
  assert.ok(Math.abs(r[9]! - (100 - 100 / 9)) < 1e-9, `实际 ${r[9]}`);
});

test('SMA9 是对 RSI 序列的额外平滑，不是第二次计算 RSI', () => {
  const rsi = [null, null, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  const sma = smoothSeries(rsi, 9);
  assert.equal(sma[9], null, '只有 8 个有效 RSI 时还不能有 SMA9');
  assert.equal(sma[10], (10 + 20 + 30 + 40 + 50 + 60 + 70 + 80 + 90) / 9);
});

test('序列中断后 SMA 重新累计，不跨缺口拼接', () => {
  const sma = smoothSeries([1, 2, 3, null, 4, 5, 6], 3);
  assert.equal(sma[2], 2);
  assert.equal(sma[4], null, '缺口之后要重新攒够 3 个');
  assert.equal(sma[6], 5);
});

/** 生成一段先温和上涨、再急涨把 RSI 顶到 ≥90 的 1m 序列。 */
function heatUp(warm: number, spike: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < warm; i++) out.push(100 + (i % 2 === 0 ? 1 : -0.9) * (i % 5));
  let p = out[out.length - 1]!;
  for (let i = 0; i < spike; i++) { p *= 1.05; out.push(p); }
  return out;
}

test('raw RSI 首次上穿 90 发一次；持续 ≥90 不重复', () => {
  const series = rsiFromCandles(bars(heatUp(100, 20), TF1), cfg);
  const r = detectOverheat(series, cfg);
  assert.equal(r.events.length, 1, `过热事件应只有一条，实际 ${r.events.length}`);
  assert.equal(r.events[0]!.firstObservation, false, '这是真正的上穿，不是首次观测');
  assert.ok(r.events[0]!.rsi >= cfg.overheat);
  assert.match(r.events[0]!.text, /分批减仓/);
});

test('SMA9 不参与 90 阈值判定', () => {
  const series = rsiFromCandles(bars(heatUp(100, 20), TF1), cfg);
  const hot = series.points.filter(p => p.rsi >= cfg.overheat);
  assert.ok(hot.length > 0);
  // 平滑线明显低于 raw，如果拿它判定就一条都不会发
  assert.ok(hot[0]!.smoothed !== null && hot[0]!.smoothed! < hot[0]!.rsi);
});

test('预热不足标 short_warmup，而不是当成正常结果', () => {
  const series = rsiFromCandles(bars(heatUp(5, 15), TF1), cfg);
  const r = detectOverheat(series, cfg);
  assert.equal(series.shortWarmup, true);
  assert.ok(r.evaluations.some(e => e.rule === 'rsi.warmup' && e.result === 'unknown'));
});

test('真实成交桶不足 70% 时只本地记录，不发过热事件', () => {
  const closes = heatUp(100, 20);
  const specs = closes.map((c, i) => (i >= closes.length - 20 && i % 2 === 0
    ? { close: c, kind: 'synthetic' as const } : { close: c }));
  const series = rsiFromCandles(bars(specs, TF1), cfg);
  const r = detectOverheat(series, cfg);
  assert.ok(series.realRatioRecent < 0.70);
  assert.equal(r.events.length, 0, 'synthetic 平线算出来的 RSI 不能用来刷屏');
  assert.ok(r.evaluations.some(e => e.rule === 'rsi.real_activity' && e.result === 'unknown'));
});

test('开始跟踪时已 ≥90 → 发一次「首次观测已过热」，不冒称刚上穿', () => {
  // 序列一开始就单调急涨，第一个 RSI 就是 100
  const series = rsiFromCandles(bars(Array.from({ length: 30 }, (_, i) => 100 * 1.05 ** i), TF1), cfg);
  const r = detectOverheat(series, cfg);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.firstObservation, true);
  assert.match(r.events[0]!.text, /首次观测已过热/);
});

test('重新武装需要连续 2 根 ≤80 且距上次事件至少 30 分钟', () => {
  const series = rsiFromCandles(bars(heatUp(100, 20), TF1), cfg);
  const first = detectOverheat(series, cfg);
  assert.equal(first.state.armed, false, '发过之后必须解除武装');
  // 只隔 1 分钟就回落，冷却时间不够，仍不得重新武装
  const soon = detectOverheat(series, { ...cfg, cooldown_minutes: 1e9 });
  assert.equal(soon.state.armed, false);
});

test('参考线文案明确 80/20 不自动产生信号', () => {
  const series = rsiFromCandles(bars(heatUp(100, 5), TF1), cfg);
  const r = detectOverheat(series, cfg);
  const v = r.evaluations.find(e => e.rule === 'rsi.value')!;
  assert.match(v.reason, /只是参考线/);
  assert.match(v.reason, /不自动产生抄底信号/);
});
