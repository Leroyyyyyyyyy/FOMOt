import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getCursor, setCursor } from '../src/db.js';
import { swapUsd, recordSwap, volumeUsd, activeTokens } from '../src/chain/volume.js';
import { resolveQuoteCached, isQuote, splitPair, ZERO } from '../src/chain/quotes.js';
import { addr } from './helpers/fixtures.js';

const CA = addr(0x5ca4);
const POOL = '0xpool-scan';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as `0x${string}`;

test.beforeEach(() => {
  db.exec("DELETE FROM swaps WHERE pool_id='" + POOL + "'");
  db.exec("DELETE FROM pools WHERE pool_id='" + POOL + "'");
  db.prepare('INSERT INTO pools (pool_id,ca,quote,token_is0,fee,hooks,init_block,init_ts) VALUES (?,?,?,?,?,?,?,?)')
    .run(POOL, CA, USDG, 1, 0, null, 1, Date.now());
});

test('swapUsd 取计价侧的绝对值，方向不影响成交额', () => {
  // token 是 currency0 → 计价侧是 amount1
  assert.equal(swapUsd(-1_000n, 5_000_000n, true, 6, 1), 5);
  assert.equal(swapUsd(1_000n, -5_000_000n, true, 6, 1), 5);
  // token 是 currency1 → 计价侧是 amount0
  assert.equal(swapUsd(-2_000_000n, 1_000n, false, 6, 1), 2);
});

test('拿不到报价时返回 null，绝不返回 usdPrice: 0', () => {
  // 原生币要现取 ETH 价；缓存里没有就必须是 null，不能退化成 0 让池子静默变死池
  assert.equal(resolveQuoteCached(ZERO, 0), null);
  // USDG 恒等于 1，不依赖网络
  assert.equal(resolveQuoteCached(USDG)?.usdPrice, 1);
  assert.equal(isQuote(USDG), true);
  assert.equal(isQuote(CA), false);
});

test('两边都不是计价资产的池子会被跳过', () => {
  assert.equal(splitPair(CA, addr(0x777)), null, '纯币币对不推送');
  const pair = splitPair(CA, USDG);
  assert.equal(pair?.token, CA);
  assert.equal(pair?.tokenIsCurrency0, true);
});

test('报价失败中断整批时游标不推进，重放后不重复累计成交量', () => {
  const now = Date.now();
  const batch = [
    { block: 100n, idx: 0, usd: 500 },
    { block: 100n, idx: 1, usd: 250 },
    { block: 101n, idx: 0, usd: 125 },     // 这一条的报价会失败
  ];
  setCursor('t_scan_cursor', '99');

  // 第一轮：处理到第三条时报价不可用 → 抛出 → 游标不推进
  assert.throws(() => {
    for (const s of batch) {
      if (s.block === 101n) throw new Error('报价不可用');
      recordSwap(POOL, s.block, s.idx, now, s.usd);
    }
    setCursor('t_scan_cursor', '101');
  }, /报价不可用/);

  assert.equal(getCursor('t_scan_cursor'), '99', '未处理完的事件不能被游标跨过去');
  assert.equal(volumeUsd(CA, 60_000), 750, '已处理的两条照常入库');

  // 第二轮：从原游标幂等重放，这次报价恢复
  for (const s of batch) recordSwap(POOL, s.block, s.idx, now, s.usd);
  setCursor('t_scan_cursor', '101');

  assert.equal(getCursor('t_scan_cursor'), '101');
  assert.equal(volumeUsd(CA, 60_000), 875, '重放不能把前两条再累计一遍（750+125，不是 1500+125）');
  db.exec("DELETE FROM cursor WHERE k='t_scan_cursor'");
});

test('同一批重放任意多次，成交量都不变', () => {
  const now = Date.now();
  for (let round = 0; round < 5; round++) {
    recordSwap(POOL, 200n, 0, now, 300);
    recordSwap(POOL, 200n, 1, now, 200);
  }
  assert.equal(volumeUsd(CA, 60_000), 500);
});

test('滚动窗口只统计窗口内的成交', () => {
  const now = Date.now();
  recordSwap(POOL, 300n, 0, now - 10 * 60_000, 999);      // 10 分钟前
  recordSwap(POOL, 301n, 0, now, 100);
  assert.equal(volumeUsd(CA, 5 * 60_000), 100, '窗口外的旧成交不能算进来');
  assert.equal(volumeUsd(CA, 60 * 60_000), 1099);
});

test('候选集只收成交额为正的代币', () => {
  const now = Date.now();
  recordSwap(POOL, 400n, 0, now, 42);
  const list = activeTokens(5 * 60_000, 300);
  const mine = list.find(t => t.ca === CA);
  assert.ok(mine, '有成交的币要出现在候选集里');
  assert.ok(mine!.usd > 0);
});
