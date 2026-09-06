import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotHolders, resetHolderCache, forgetHolders, type ChainReader } from '../src/chain/holders.js';
import { addr } from './helpers/fixtures.js';

const CA = addr(0xabc);
type Log = { blockNumber: bigint | null; args: { from: string; to: string; value: bigint } };
const xfer = (block: bigint, from: string, to: string, value: bigint): Log =>
  ({ blockNumber: block, args: { from, to, value } });
const ZERO = addr(0);
const A = addr(1), B = addr(2), C = addr(3);

/** 可注入的假链。测试全程不碰实时主网。 */
class FakeChain implements ChainReader {
  failNext = 0;
  calls: [bigint, bigint][] = [];
  constructor(public logs: Log[] = [], public hashes = new Map<string, string>()) {}
  async getLogs(_ca: `0x${string}`, from: bigint, to: bigint) {
    this.calls.push([from, to]);
    if (this.failNext > 0) { this.failNext--; throw new Error('RPC 抽风'); }
    return this.logs.filter(l => l.blockNumber! >= from && l.blockNumber! <= to);
  }
  blockCalls = 0;
  async getBlockHash(block: bigint) { this.blockCalls++; return this.hashes.get(String(block)) ?? `h${block}`; }
  async getBlockMeta(block: bigint) {
    this.blockCalls++;
    return { hash: this.hashes.get(String(block)) ?? `h${block}`, ts: 1_700_000_000_000 + Number(block) * 100 };
  }
}

const bal = (s: { balances: ReadonlyMap<string, bigint> }, a: string) => s.balances.get(a.toLowerCase()) ?? 0n;

test.beforeEach(() => resetHolderCache());

test('回滚后请求失败，再重试成功，结果等于全量重建', async () => {
  const logs = [
    xfer(10n, ZERO, A, 100n),
    xfer(20n, A, B, 30n),
    xfer(150n, A, C, 10n),          // 落在重放窗口内（lastBlock 200 - 64 + 1 = 137）
    xfer(205n, B, C, 5n),
  ];
  const chain = new FakeChain(logs);
  const first = await snapshotHolders(CA, 0n, 200n, 10, chain);
  assert.equal(bal(first, A), 60n);
  assert.equal(bal(first, B), 30n);

  // 第二次增量更新：先失败一次
  chain.failNext = 1;
  await assert.rejects(() => snapshotHolders(CA, 0n, 210n, 10, chain), /RPC 抽风/);

  // 关键：失败后缓存不能已经被改坏。重试必须拿到正确结果。
  const retry = await snapshotHolders(CA, 0n, 210n, 10, chain);

  // 与从零全量重建对照
  resetHolderCache();
  const rebuilt = await snapshotHolders(CA, 0n, 210n, 10, new FakeChain(logs));
  for (const a of [A, B, C]) {
    assert.equal(bal(retry, a), bal(rebuilt, a), `地址 ${a} 的余额应与全量重建一致`);
  }
  assert.equal(retry.total, rebuilt.total);
});

test('连续两次失败也不会把同一批 delta 重复撤销', async () => {
  const logs = [xfer(10n, ZERO, A, 100n), xfer(150n, A, B, 40n)];
  const chain = new FakeChain(logs);
  await snapshotHolders(CA, 0n, 200n, 10, chain);
  chain.failNext = 2;
  await assert.rejects(() => snapshotHolders(CA, 0n, 210n, 10, chain));
  await assert.rejects(() => snapshotHolders(CA, 0n, 210n, 10, chain));
  const ok = await snapshotHolders(CA, 0n, 210n, 10, chain);
  assert.equal(bal(ok, A), 60n, '重复撤销会让 A 变成 140；这里必须还是 60');
  assert.equal(bal(ok, B), 40n);
});

test('已返回的快照不受后续更新影响', async () => {
  const chain = new FakeChain([xfer(10n, ZERO, A, 100n)]);
  const older = await snapshotHolders(CA, 0n, 100n, 10, chain);
  const beforeTotal = older.total;
  const beforeA = bal(older, A);

  chain.logs.push(xfer(120n, A, B, 50n));
  await snapshotHolders(CA, 0n, 130n, 10, chain);

  assert.equal(bal(older, A), beforeA, '旧快照的余额表不能被改动');
  assert.equal(older.total, beforeTotal);
  assert.equal(older.atBlock, 100n);
});

test('同一 CA 的并发更新被串行化，结果与顺序执行一致', async () => {
  const logs = [xfer(10n, ZERO, A, 100n), xfer(120n, A, B, 20n), xfer(140n, A, C, 30n)];
  const chain = new FakeChain(logs);
  const [s1, s2, s3] = await Promise.all([
    snapshotHolders(CA, 0n, 130n, 10, chain),
    snapshotHolders(CA, 0n, 150n, 10, chain),
    snapshotHolders(CA, 0n, 160n, 10, chain),
  ]);
  // 串行化后每一份都自洽：余额总和守恒
  for (const s of [s1, s2, s3]) {
    const sum = [...s.balances.values()].reduce((a, b) => a + b, 0n);
    assert.equal(sum, 100n, '总量必须守恒，说明没有并发撕裂');
  }
  const last = await snapshotHolders(CA, 0n, 160n, 10, chain);
  assert.equal(bal(last, A), 50n);
  assert.equal(bal(last, B), 20n);
  assert.equal(bal(last, C), 30n);
});

test('同高度换分支：区块哈希变了要按新分支重放', async () => {
  const chain = new FakeChain([xfer(10n, ZERO, A, 100n), xfer(190n, A, B, 40n)]);
  const first = await snapshotHolders(CA, 0n, 200n, 10, chain);
  assert.equal(bal(first, B), 40n);

  // 同一高度换了分支：190 那笔没了，换成转给 C 的 25
  chain.logs = [xfer(10n, ZERO, A, 100n), xfer(190n, A, C, 25n)];
  chain.hashes.set('200', '0xdifferent');
  const after = await snapshotHolders(CA, 0n, 200n, 10, chain);
  assert.equal(bal(after, B), 0n, '旧分支的转账必须被撤销');
  assert.equal(bal(after, C), 25n);
  assert.equal(bal(after, A), 75n);
});

test('head 倒退且在回放窗口内：回滚到较低高度', async () => {
  const chain = new FakeChain([xfer(10n, ZERO, A, 100n), xfer(195n, A, B, 40n)]);
  await snapshotHolders(CA, 0n, 200n, 10, chain);
  const back = await snapshotHolders(CA, 0n, 190n, 10, chain);
  assert.equal(bal(back, B), 0n, '高于新 head 的转账必须撤销');
  assert.equal(bal(back, A), 100n);
  assert.equal(back.atBlock, 190n);
});

test('head 倒退超出回放窗口：重建而不是假装能处理', async () => {
  const chain = new FakeChain([xfer(10n, ZERO, A, 100n), xfer(500n, A, B, 40n)]);
  await snapshotHolders(CA, 0n, 1000n, 10, chain);
  const back = await snapshotHolders(CA, 0n, 100n, 10, chain);   // 倒退 900 块 >> 64
  assert.equal(back.rebuilt, true, '必须明确标记为重建');
  assert.equal(bal(back, A), 100n);
  assert.equal(bal(back, B), 0n);
});

test('不同 CA 之间互不干扰', async () => {
  const other = addr(0xdef);
  const c1 = new FakeChain([xfer(10n, ZERO, A, 100n)]);
  const c2 = new FakeChain([xfer(10n, ZERO, B, 7n)]);
  const s1 = await snapshotHolders(CA, 0n, 50n, 10, c1);
  const s2 = await snapshotHolders(other, 0n, 50n, 10, c2);
  assert.equal(bal(s1, A), 100n);
  assert.equal(bal(s2, B), 7n);
  assert.equal(bal(s2, A), 0n);
  forgetHolders(other);
});

test('快照分开记录链上区块时间与采集时间', async () => {
  const chain = new FakeChain([xfer(10n, ZERO, A, 100n)]);
  const s = await snapshotHolders(CA, 0n, 42n, 10, chain);
  assert.equal(s.atBlock, 42n);
  assert.equal(s.blockTs, 1_700_000_000_000 + 4200);
  assert.ok(s.takenTs > 1_700_000_000_000, '采集时间是真实时钟，与区块时间不同源');
  assert.notEqual(s.blockTs, s.takenTs);
});

test('热路径上不为同一个区块重复取块：一次快照只取一次元数据', async () => {
  const chain = new FakeChain([xfer(10n, ZERO, A, 100n)]);
  await snapshotHolders(CA, 0n, 50n, 10, chain);
  // 首次快照没有缓存可比对，只应该为 tip 取一次元数据
  assert.equal(chain.blockCalls, 1, `一次快照只该取一次区块，实际 ${chain.blockCalls} 次`);
});
