import test from 'node:test';
import assert from 'node:assert/strict';
import { isLogLimitError, AdaptiveRange, scanRange } from '../src/chain/logrange.js';

test('adaptive log scanning recognizes provider and transport size errors', () => {
  assert.equal(isLogLimitError(new Error('logs matched by query exceeds limit of 10000')), true);
  assert.equal(isLogLimitError(new Error('Invalid parameters were provided to the RPC method')), true);
  assert.equal(isLogLimitError(new Error('ResponseBodyTooLargeError: HTTP response body exceeded the size limit')), true);
});

test('a block number ending in 32000 is not mistaken for an RPC log limit', () => {
  assert.equal(isLogLimitError(new Error('getLogs 31401-32000: socket closed')), false);
});

const LIMIT = new Error('logs matched by query exceeds limit of 10000');

/** 每块一条日志的假链；一次命中超过 `cap` 条就报超限。 */
function denseChain(cap: number) {
  const calls: [bigint, bigint][] = [];
  const fetch = async (lo: bigint, hi: bigint) => {
    calls.push([lo, hi]);
    if (Number(hi - lo + 1n) > cap) throw LIMIT;
    const out: bigint[] = [];
    for (let b = lo; b <= hi; b++) out.push(b);
    return out;
  };
  return { calls, fetch };
}

test('分片失败后缩小区间，最终完整取回且不重不漏', async () => {
  const { calls, fetch } = denseChain(100);
  const range = new AdaptiveRange(1_000n, 10n, 5_000n, 'test');
  const got = await scanRange(range, 1n, 1_000n, fetch);

  assert.ok(calls.some(([lo, hi]) => Number(hi - lo + 1n) > 100), '必须真的先撞过一次上限');
  assert.equal(got.length, 1_000, '总条数不能少');
  assert.equal(new Set(got.map(String)).size, 1_000, '不能重复');
  const sorted = [...got].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.equal(sorted[0], 1n);
  assert.equal(sorted[999], 1_000n);
  for (let i = 1; i < sorted.length; i++) {
    assert.equal(sorted[i]! - sorted[i - 1]!, 1n, `区块 ${sorted[i - 1]} 之后断了`);
  }
});

test('极端密集时一路缩到最小仍能取全', async () => {
  const { fetch } = denseChain(10);
  const range = new AdaptiveRange(4_000n, 10n, 8_000n, 'test');
  const got = await scanRange(range, 1n, 200n, fetch);
  assert.equal(got.length, 200);
  assert.equal(new Set(got.map(String)).size, 200);
});

test('缩到最小仍失败就把真实故障抛出去，不再无限缩', async () => {
  let calls = 0;
  const range = new AdaptiveRange(64n, 16n, 1_000n, 'test');
  await assert.rejects(
    () => scanRange(range, 1n, 500n, async () => { calls++; throw LIMIT; }),
    /exceeds limit/);
  assert.ok(calls < 20, `不能无限重试，实际调用 ${calls} 次`);
});

test('非超限错误直接上抛，不会被当成需要缩范围', async () => {
  const range = new AdaptiveRange(500n, 10n, 1_000n, 'test');
  let calls = 0;
  await assert.rejects(
    () => scanRange(range, 1n, 1_000n, async () => { calls++; throw new Error('socket closed'); }),
    /socket closed/);
  assert.equal(calls, 1, '普通网络故障不该触发缩范围重试');
});

test('顺利时范围会涨回去，但不超过上限', () => {
  const range = new AdaptiveRange(100n, 10n, 300n, 'test');
  for (let i = 0; i < 50; i++) range.grow();
  assert.equal(range.value, 300n);
  assert.equal(range.shrink(), true);
  assert.equal(range.value, 150n);
});

test('缩到下限后 shrink 返回 false', () => {
  const range = new AdaptiveRange(20n, 10n, 100n, 'test');
  assert.equal(range.shrink(), true);
  assert.equal(range.value, 10n);
  assert.equal(range.shrink(), false, '已经到最小，说明是别的问题');
});
