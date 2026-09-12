import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { migratePostSchema, POST_TABLES } from '../src/post/store.js';
import { recordQuote, quoteAt, pegQuote, pegBroken } from '../src/post/market/quotes.js';
import { ingestSwaps, repriceMissing, loadSwaps, quoteSideUsd, postSwapPrice, rollbackBlock } from '../src/post/market/events.js';
import { recordInterval, recordGap, coverageOf, watermark, closeGap } from '../src/post/market/coverage.js';
import { buildMinuteCandles, rollUp, loadCandles, aggregateRaw, realBarRatio } from '../src/post/market/candles.js';
import { recordSupply, supplyAt, fdvUsd, supplyChanged } from '../src/post/market/supply.js';
import { createSeries, choosePrimaryPool, detectPriceConflict } from '../src/post/market/series.js';
import type { PoolMeta, SwapEvent } from '../src/post/types.js';

migratePostSchema();
test.beforeEach(() => { for (const t of POST_TABLES) db.exec(`DELETE FROM ${t}`); });

const CHAIN = 4663;
const CA = '0xabc';
const T0 = 1_800_000_000_000;                    // 正好落在分钟边界
const MIN = 60_000;

/** token 是 currency0、18 位；quote 是 WETH、18 位。 */
const pool: PoolMeta = {
  chainId: CHAIN, poolId: '0xpool1', ca: CA, quote: '0xweth', quoteSymbol: 'ETH',
  quoteDecimals: 18, tokenIs0: true, tokenDecimals: 18,
};

/** 构造一个 sqrtPriceX96，使 token 的计价币价格 = p（两边同为 18 位小数）。 */
const sqrtFor = (p: number) => BigInt(Math.round(Math.sqrt(p) * 2 ** 96));

function swap(n: number, ts: number, price: number, quoteAmt: bigint, poolId = pool.poolId): SwapEvent {
  return {
    chainId: CHAIN, poolId, blockNumber: 1000 + n, blockHash: `0xb${n}`, txHash: `0xt${n}`,
    txIndex: 0, logIndex: 0, eventTs: ts, observedAt: ts,
    amount0: -quoteAmt, amount1: quoteAmt, sqrtPriceX96: sqrtFor(price),
  };
}
function ethQuote(ts: number, usd = 2000, availableAt = ts) {
  recordQuote({ source: 'coinbase', asset: 'ETH', quoteTs: ts, usd, availableAt, quality: 'historical' });
}
function pool1() {
  db.prepare(`INSERT INTO post_pools (chain_id,pool_id,ca,quote,quote_symbol,quote_decimals,token_is0,token_decimals,init_block,init_ts)
    VALUES (?,?,?,?,?,?,1,18,1,?) ON CONFLICT DO NOTHING`)
    .run(CHAIN, pool.poolId, CA, pool.quote, 'ETH', 18, T0);
}

// ── 报价 ───────────────────────────────────────────────────────────────────

test('报价只找事件时点之前、且当时真的可用的那一条', () => {
  ethQuote(T0 - 30_000, 2000);
  ethQuote(T0 + 30_000, 9999);                   // 事件之后的报价，不许用
  const q = quoteAt('ETH', T0);
  assert.equal(q.usd, 2000);
  assert.equal(q.quality, 'historical');
});

test('报价的 available_at 晚于事件时点就不能用——这正是「分钟 close 定价分钟内交易」的前视', () => {
  recordQuote({ source: 'x', asset: 'ETH', quoteTs: T0 - 10_000, usd: 2000, availableAt: T0 + 50_000, quality: 'historical' });
  assert.equal(quoteAt('ETH', T0).quality, 'missing');
});

test('报价滞后超过 120s 视为无价，不用当前价回算历史', () => {
  ethQuote(T0 - 200_000, 2000);
  const q = quoteAt('ETH', T0);
  assert.equal(q.usd, null);
  assert.equal(q.quality, 'missing');
  assert.match(q.reason, /超过 120s/);
});

test('USDG 的 $1 是 peg_proxy 假设，不是观测价；偏离判定只在有现价时才生效', () => {
  assert.equal(pegQuote('USDG', T0).quality, 'peg_proxy');
  assert.equal(pegBroken(null, 0.02), false, '没有现价时不能假装验证过');
  assert.equal(pegBroken(1.005, 0.02), false);
  assert.equal(pegBroken(0.95, 0.02), true);
});

// ── 定价 ───────────────────────────────────────────────────────────────────

test('一笔成交只算 quote 侧一边，不把两边相加', () => {
  // token 侧 1000 个、quote 侧 2 个 → 只应算 quote 侧的 2 × $2000
  assert.equal(quoteSideUsd(-1000n * 10n ** 18n, 2n * 10n ** 18n, true, 18, 2000), 4000);
  assert.equal(quoteSideUsd(2n * 10n ** 18n, -1000n * 10n ** 18n, false, 18, 2000), 4000);
});

test('成交后池价按 sqrtPriceX96 还原，token0/token1 方向都对', () => {
  const p = postSwapPrice(swap(1, T0, 0.25, 10n ** 18n), pool);
  assert.ok(Math.abs(p - 0.25) < 1e-9, `期望 0.25，实际 ${p}`);
  const inverted = postSwapPrice(swap(1, T0, 0.25, 10n ** 18n), { ...pool, tokenIs0: false });
  assert.ok(Math.abs(inverted - 4) < 1e-9, `token 是 currency1 时应为倒数，实际 ${inverted}`);
});

test('拿不到合规报价时 price/volume 是 null 而不是 0，原始日志照样入库', () => {
  const r = ingestSwaps([swap(1, T0, 0.25, 10n ** 18n)], pool);
  assert.equal(r.inserted, 1);
  assert.equal(r.unpriced, 1, '没有报价时必须计入 unpriced');
  const [s] = loadSwaps(pool.poolId, T0 - MIN, T0 + MIN);
  assert.equal(s!.priceUsd, null);
  assert.equal(s!.volumeUsd, null);
  assert.equal(s!.quoteQuality, 'missing');
});

test('报价恢复后可以补算，不需要重新采集原始日志', () => {
  ingestSwaps([swap(1, T0, 0.25, 10n ** 18n)], pool);
  ethQuote(T0 - 1000, 2000);
  const r = repriceMissing(pool);
  assert.deepEqual(r, { repriced: 1, stillMissing: 0 });
  const [s] = loadSwaps(pool.poolId, T0 - MIN, T0 + MIN);
  assert.ok(Math.abs(s!.priceUsd! - 500) < 1e-6, `0.25 ETH × $2000 = $500，实际 ${s!.priceUsd}`);
  assert.ok(Math.abs(s!.volumeUsd! - 2000) < 1e-6);
});

test('重复回放同一批事件不会重复计量', () => {
  ethQuote(T0 - 1000);
  const batch = [swap(1, T0, 0.25, 10n ** 18n), swap(2, T0 + 1000, 0.26, 10n ** 18n)];
  assert.equal(ingestSwaps(batch, pool).inserted, 2);
  assert.equal(ingestSwaps(batch, pool).inserted, 0, '幂等：第二次不应再插入');
  assert.equal(loadSwaps(pool.poolId, T0 - MIN, T0 + MIN).length, 2);
});

test('乱序到达也按 (block, txIndex, logIndex) 定 open/close，不按到达顺序', () => {
  ethQuote(T0 - 1000);
  const a = { ...swap(1, T0 + 10, 1.0, 10n ** 18n), blockNumber: 1000, txIndex: 0, logIndex: 0 };
  const b = { ...swap(2, T0 + 10, 2.0, 10n ** 18n), blockNumber: 1000, txIndex: 0, logIndex: 5 };
  const c = { ...swap(3, T0 + 10, 3.0, 10n ** 18n), blockNumber: 1000, txIndex: 1, logIndex: 1 };
  ingestSwaps([c, a, b], pool);                   // 乱序喂进去
  const rows = loadSwaps(pool.poolId, T0, T0 + MIN);
  const bars = aggregateRaw(rows, 60);
  const bar = bars.get(T0)!;
  assert.ok(Math.abs(bar.open - 2000) < 1e-6, 'open 必须是链上顺序第一条（1.0 × $2000）');
  assert.ok(Math.abs(bar.close - 6000) < 1e-6, 'close 必须是链上顺序最后一条（3.0 × $2000）');
  assert.equal(bar.swaps, 3);
});

test('重组回滚按 block_hash 生效，同高度的新链事件是另一行', () => {
  ethQuote(T0 - 1000);
  ingestSwaps([swap(1, T0, 1, 10n ** 18n)], pool);
  const forked = { ...swap(1, T0, 2, 10n ** 18n), blockHash: '0xfork', txHash: '0xtfork' };
  ingestSwaps([forked], pool);
  assert.equal(loadSwaps(pool.poolId, T0, T0 + MIN).length, 2);
  assert.equal(rollbackBlock(CHAIN, '0xb1'), 1);
  assert.equal(loadSwaps(pool.poolId, T0, T0 + MIN).length, 1, '只回滚被弃链的那条');
});

// ── 覆盖 ───────────────────────────────────────────────────────────────────

test('水位是「连续完成至此」，不是见过的最大 block', () => {
  recordInterval(CHAIN, pool.poolId, 'realtime', 100, 200, T0, T0 + MIN);
  recordInterval(CHAIN, pool.poolId, 'realtime', 500, 900, T0 + 5 * MIN, T0 + 9 * MIN);
  assert.equal(watermark(CHAIN, pool.poolId, 'realtime').block, 200, '中间断了就不能把 900 当水位');
});

test('相邻区间会合并，碎片不会把连续覆盖误判成缺口', () => {
  recordInterval(CHAIN, pool.poolId, 'realtime', 100, 200, T0, T0 + MIN);
  recordInterval(CHAIN, pool.poolId, 'realtime', 201, 300, T0 + MIN, T0 + 2 * MIN);
  assert.equal(watermark(CHAIN, pool.poolId, 'realtime').block, 300);
  assert.equal(coverageOf(CHAIN, pool.poolId, T0, T0 + 2 * MIN), 'complete');
});

test('gap 与 pending 必须分开：一个是扫过但缺数据，一个是还没轮到', () => {
  assert.equal(coverageOf(CHAIN, pool.poolId, T0, T0 + MIN), 'pending');
  recordGap(CHAIN, pool.poolId, 100, 200, T0, T0 + MIN, '落后超过一小时被跳过');
  assert.equal(coverageOf(CHAIN, pool.poolId, T0, T0 + MIN), 'gap');
  closeGap(CHAIN, pool.poolId, 100, 200, T0, T0 + MIN);
  assert.equal(coverageOf(CHAIN, pool.poolId, T0, T0 + MIN), 'complete');
});

// ── K 线 ───────────────────────────────────────────────────────────────────

function seedSeries() {
  pool1();
  return createSeries(CHAIN, CA, pool.poolId, T0);
}

test('扫描完整但没有成交 → synthetic 平线；有缺口 → unknown，绝不伪造零量平线', () => {
  const s = seedSeries();
  ethQuote(T0 - 1000);
  ingestSwaps([swap(1, T0 + 10, 1, 10n ** 18n)], pool);
  // 第 1 分钟扫描完整（无成交），第 2 分钟是缺口
  recordInterval(CHAIN, pool.poolId, 'realtime', 1, 2, T0, T0 + 2 * MIN);
  recordGap(CHAIN, pool.poolId, 3, 4, T0 + 2 * MIN, T0 + 3 * MIN, 'RPC 丢了一段');

  buildMinuteCandles(s, loadSwaps(pool.poolId, T0, T0 + 3 * MIN), T0, T0 + 3 * MIN,
    { watermarkTs: T0 + 10 * MIN, graceSeconds: 5 });

  const cs = loadCandles(s.seriesId, 60, T0, T0 + 3 * MIN);
  assert.equal(cs.length, 3);
  assert.equal(cs[0]!.synthetic, false);
  assert.equal(cs[1]!.synthetic, true, '扫描完整的空桶才是 synthetic');
  assert.equal(cs[1]!.volumeUsd, 0);
  assert.equal(cs[2]!.quality, 'unknown', '缺口桶必须是 unknown');
  assert.equal(cs[2]!.close, null, 'unknown 桶不能有价格');
  assert.equal(cs[2]!.volumeUsd, null, 'unknown 桶不能写 volume=0');
});

test('高周期必须由完整 1m 聚合；缺一根 1m 父桶就不是 complete', () => {
  const s = seedSeries();
  // 报价必须逐分钟都有：只留一条 T0 的报价时，两分钟后的成交就超过 120s 滞后上限，
  // 会被判成 missing，随后变成 synthetic 平线——这本身就是正确行为。
  for (let i = -1; i <= 5; i++) ethQuote(T0 + i * MIN);
  // 每一分钟都有成交：第一根桶没有前值就只能是 unknown（不能凭空造平线）
  const swaps = [0, 1, 2, 3, 4].map(i => swap(i, T0 + i * MIN + 10, i + 1, 10n ** 18n));
  ingestSwaps(swaps, pool);
  recordInterval(CHAIN, pool.poolId, 'realtime', 1, 9, T0, T0 + 5 * MIN);
  buildMinuteCandles(s, loadSwaps(pool.poolId, T0, T0 + 5 * MIN), T0, T0 + 5 * MIN,
    { watermarkTs: T0 + 10 * MIN, graceSeconds: 5 });
  rollUp(s, 300, T0, T0 + 5 * MIN, { watermarkTs: T0 + 10 * MIN, graceSeconds: 5 });

  const [m5] = loadCandles(s.seriesId, 300, T0, T0 + 5 * MIN);
  assert.equal(m5!.quality, 'complete');
  // sqrtPriceX96 是整数编码，还原价格有 ~1e-9 的相对误差，用相对容差断言
  const near = (a: number, b: number) => Math.abs(a - b) / b < 1e-6;
  assert.ok(near(m5!.open, 1 * 2000), `父桶 open 必须等于第一根 1m 的 open，实际 ${m5!.open}`);
  assert.ok(near(m5!.close, 5 * 2000), `父桶 close 必须等于最后一根 1m 的 close，实际 ${m5!.close}`);
  assert.ok(near(m5!.high, 5 * 2000));
  assert.ok(near(m5!.low, 1 * 2000));
  assert.equal(m5!.swaps, 5, '父桶成交笔数必须等于子桶之和（可复算）');

  // 挖掉一根 1m 再复算，父桶必须掉成 unknown
  db.prepare('DELETE FROM post_candles WHERE series_id=? AND timeframe_sec=60 AND open_ts=?').run(s.seriesId, T0 + 2 * MIN);
  rollUp(s, 300, T0, T0 + 5 * MIN, { watermarkTs: T0 + 10 * MIN, graceSeconds: 5 });
  assert.equal(loadCandles(s.seriesId, 300, T0, T0 + 5 * MIN)[0]!.quality, 'unknown');
});

test('策略只读已收盘且水位越过的桶——asOf 截断保证无前视', () => {
  const s = seedSeries();
  ethQuote(T0 - 1000);
  ingestSwaps([swap(1, T0 + 10, 1, 10n ** 18n), swap(2, T0 + MIN + 10, 2, 10n ** 18n)], pool);
  recordInterval(CHAIN, pool.poolId, 'realtime', 1, 9, T0, T0 + 2 * MIN);
  // 水位只到第 1 分钟收盘 +5s
  buildMinuteCandles(s, loadSwaps(pool.poolId, T0, T0 + 2 * MIN), T0, T0 + 2 * MIN,
    { watermarkTs: T0 + MIN + 5_000, graceSeconds: 5 });

  assert.equal(loadCandles(s.seriesId, 60, T0, T0 + 2 * MIN).length, 1, '第二根还没确认收盘，不能给策略');
  assert.equal(loadCandles(s.seriesId, 60, T0, T0 + 2 * MIN, { closedOnly: false }).length, 2);
  assert.equal(loadCandles(s.seriesId, 60, T0, T0 + 2 * MIN, { asOf: T0 }).length, 0, 'asOf 之前什么都看不到');
});

test('真实成交桶占比只数非 synthetic、非 unknown 且有成交的桶', () => {
  const mk = (over: any) => ({ synthetic: false, quality: 'complete', swaps: 1, ...over } as any);
  assert.equal(realBarRatio([mk({}), mk({ synthetic: true }), mk({ quality: 'unknown' }), mk({ swaps: 0 })]), 0.25);
  assert.equal(realBarRatio([]), 0);
});

// ── 供应量 / FDV ───────────────────────────────────────────────────────────

test('历史 FDV 只能用当时的供应量；没有时点快照就是 null', () => {
  assert.equal(supplyAt(CHAIN, CA, T0), null);
  recordSupply(CHAIN, CA, 1000, 1_000_000n * 10n ** 18n, 18, T0, T0, 'rpc');
  assert.equal(supplyAt(CHAIN, CA, T0 - 1), null, '快照之前的时点不能用后来的供应量');
  assert.equal(supplyAt(CHAIN, CA, T0 + MIN), 1_000_000);
  assert.equal(fdvUsd(0.5, 1_000_000), 500_000);
  assert.equal(fdvUsd(0.5, null), null);
});

test('供应量变化能被检出——只靠供应变化的 FDV 新高不算价格突破', () => {
  recordSupply(CHAIN, CA, 1000, 1_000_000n * 10n ** 18n, 18, T0, T0, 'rpc');
  assert.equal(supplyChanged(CHAIN, CA, T0 - MIN, T0 + MIN), false);
  recordSupply(CHAIN, CA, 2000, 3_000_000n * 10n ** 18n, 18, T0 + MIN, T0 + MIN, 'rpc');
  assert.equal(supplyChanged(CHAIN, CA, T0 - MIN, T0 + 2 * MIN), true);
});

// ── 主池 / 冲突 ────────────────────────────────────────────────────────────

test('主池按窗口成交额选，并列按 poolId 定序（重放必须选到同一个池）', () => {
  pool1();
  db.prepare(`INSERT INTO post_pools (chain_id,pool_id,ca,quote,quote_symbol,quote_decimals,token_is0,token_decimals,init_block,init_ts)
    VALUES (?,'0xpool2',?,?,?,?,1,18,1,?)`).run(CHAIN, CA, pool.quote, 'ETH', 18, T0);
  ethQuote(T0 - 1000);
  ingestSwaps([swap(1, T0 + 10, 1, 10n ** 18n)], pool);
  ingestSwaps([swap(2, T0 + 20, 1, 5n * 10n ** 18n, '0xpool2')], { ...pool, poolId: '0xpool2' });

  const r = choosePrimaryPool(CHAIN, CA, T0 + MIN);
  assert.equal(r.poolId, '0xpool2', '成交额大的池胜出');
  assert.match(r.reason, /成交额最大/);
});

test('另一个池持续报出背离价格时标冲突，而不是挑高价池制造突破', () => {
  pool1();
  db.prepare(`INSERT INTO post_pools (chain_id,pool_id,ca,quote,quote_symbol,quote_decimals,token_is0,token_decimals,init_block,init_ts)
    VALUES (?,'0xpool2',?,?,?,?,1,18,1,?)`).run(CHAIN, CA, pool.quote, 'ETH', 18, T0);
  ethQuote(T0 - 1000);
  ingestSwaps([1, 2, 3].map(i => swap(i, T0 + i, 1, 10n ** 18n)), pool);
  ingestSwaps([11, 12, 13].map(i => swap(i, T0 + i, 1.5, 10n ** 18n, '0xpool2')), { ...pool, poolId: '0xpool2' });

  const c = detectPriceConflict(CHAIN, CA, pool.poolId, T0, T0 + MIN, 0.10);
  assert.equal(c.conflict, true);
  assert.ok(c.maxDeviation > 0.4, `偏离应约 50%，实际 ${c.maxDeviation}`);
});

test('样本不足时不下冲突结论', () => {
  pool1();
  db.prepare(`INSERT INTO post_pools (chain_id,pool_id,ca,quote,quote_symbol,quote_decimals,token_is0,token_decimals,init_block,init_ts)
    VALUES (?,'0xpool2',?,?,?,?,1,18,1,?)`).run(CHAIN, CA, pool.quote, 'ETH', 18, T0);
  ethQuote(T0 - 1000);
  ingestSwaps([swap(1, T0 + 1, 1, 10n ** 18n)], pool);
  ingestSwaps([swap(11, T0 + 2, 5, 10n ** 18n, '0xpool2')], { ...pool, poolId: '0xpool2' });
  const c = detectPriceConflict(CHAIN, CA, pool.poolId, T0, T0 + MIN, 0.10);
  assert.equal(c.conflict, false);
  assert.match(c.detail, /样本不足/);
});
