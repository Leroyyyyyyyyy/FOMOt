import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPivots, quantile, median, olsSlopePerHour, emptyPivotState, stepPivot } from '../src/post/patterns/pivots.js';
import { bars, TF15 } from './helpers/post-bars.js';

test('高点要等回撤 20% 之后才确认，confirmedAt 必须晚于 extremeTs', () => {
  //           100  120  150  140  120(-20%)
  const cs = bars([100, 120, 150, 140, 120], TF15);
  const { pivots } = detectPivots(cs, 0.20);
  assert.equal(pivots.length, 1);
  const p = pivots[0]!;
  assert.equal(p.kind, 'high');
  assert.equal(p.price, 150);
  assert.equal(p.extremeTs, cs[2]!.closeTs, '极值是 150 那根');
  assert.equal(p.confirmedAt, cs[4]!.closeTs, '确认是回撤到 120 那根');
  assert.ok(p.confirmedAt > p.extremeTs, 'confirmedAt 绝不能回填成 extremeTs');
});

test('差 0.01 没到阈值就不确认——边界不放水', () => {
  // 150 → 120.1 是 -19.93%，不足 20%
  assert.equal(detectPivots(bars([100, 150, 120.1], TF15), 0.20).pivots.length, 0);
  assert.equal(detectPivots(bars([100, 150, 120], TF15), 0.20).pivots.length, 1);
});

test('一根 K 最多确认一个节点，相反方向必须等下一根', () => {
  // 100 涨到 200，再一根直接砸到 100（-50%）：这一根只能确认高点
  const cs = bars([100, 200, 100], TF15);
  const { pivots } = detectPivots(cs, 0.20);
  assert.equal(pivots.length, 1);
  assert.equal(pivots[0]!.kind, 'high');
});

test('相同价格取最早极值', () => {
  const cs = bars([100, 150, 150, 120], TF15);
  const { pivots } = detectPivots(cs, 0.20);
  assert.equal(pivots[0]!.extremeTs, cs[1]!.closeTs, '两根同为 150 时取前一根');
});

test('synthetic 平线不参与 pivot；unknown 缺口重置未确认节点', () => {
  const withSynthetic = bars([100, 150, { close: 150, kind: 'synthetic' }, 120], TF15);
  assert.equal(detectPivots(withSynthetic, 0.20).pivots.length, 1, 'synthetic 只是跳过，不影响已有 running 极值');

  const withGap = bars([100, 150, { close: 0, kind: 'unknown' }, 120], TF15);
  assert.equal(detectPivots(withGap, 0.20).pivots.length, 0,
    '跨过看不见的一段后，手上的 running 极值已经没有意义，必须重置');
});

test('低点确认对称：下行中反弹 20% 才确认低点', () => {
  const cs = bars([200, 150, 100, 80, 96], TF15);   // 80 → 96 正好 +20%
  const { pivots } = detectPivots(cs, 0.20);
  assert.equal(pivots.length, 2);
  assert.equal(pivots[0]!.kind, 'high');
  assert.equal(pivots[1]!.kind, 'low');
  assert.equal(pivots[1]!.price, 80);
});

test('逐根喂与整段跑结果一致（回放必须等同实时）', () => {
  const cs = bars([100, 120, 150, 140, 120, 130, 100, 130], TF15);
  let s = emptyPivotState();
  for (const b of cs) s = stepPivot(s, b, 0.20).state;
  assert.deepEqual(s.pivots, detectPivots(cs, 0.20).pivots);
});

test('分位数固定 linear interpolation，索引 (n-1)*q', () => {
  const v = [1, 2, 3, 4, 5];
  assert.equal(quantile(v, 0), 1);
  assert.equal(quantile(v, 1), 5);
  assert.equal(median(v), 3);
  // (5-1)*0.1 = 0.4 → 1 + (2-1)*0.4 = 1.4
  assert.ok(Math.abs(quantile(v, 0.10) - 1.4) < 1e-12);
  assert.ok(Math.abs(quantile(v, 0.90) - 4.6) < 1e-12);
});

test('OLS 自变量是真实经过小时，不是样本序号', () => {
  // 每小时涨 2，但中间缺了几个样本；用序号会算出错误斜率
  const pts = [{ hours: 0, value: 10 }, { hours: 1, value: 12 }, { hours: 5, value: 20 }];
  assert.ok(Math.abs(olsSlopePerHour(pts) - 2) < 1e-9);
  assert.equal(olsSlopePerHour([{ hours: 3, value: 7 }]), 0, '单点没有斜率');
});
