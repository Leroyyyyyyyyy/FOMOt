import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { migratePostSchema, POST_TABLES } from '../src/post/store.js';
import { recordQuote } from '../src/post/market/quotes.js';
import { recordSupply } from '../src/post/market/supply.js';
import { ingestSwaps, loadSwaps } from '../src/post/market/events.js';
import { recordInterval } from '../src/post/market/coverage.js';
import { buildMinuteCandles, rollUp, loadCandles } from '../src/post/market/candles.js';
import { createSeries } from '../src/post/market/series.js';
import { evaluateEpisodes, type EvaluationContext } from '../src/post/run.js';
import { saveReport } from '../src/post/narrative.js';
import { lease, dispatch, offPort, outboxStats } from '../src/post/outbox.js';
import { postConfig } from '../src/post/config.js';
import { firstTradeOf } from '../src/post/discovery.js';
import type { PoolMeta, SwapEvent } from '../src/post/types.js';

migratePostSchema();
test.beforeEach(() => { for (const t of POST_TABLES) db.exec(`DELETE FROM ${t}`); });

const CHAIN = 4663;
const CA = '0xaaaa000000000000000000000000000000000001';
const POOL = '0xpoolE2E';
const MIN = 60_000;
/** 对齐到 15m 边界，方便手算 */
const T0 = Math.floor(1_800_000_000_000 / (900_000)) * 900_000;

const pool: PoolMeta = {
  chainId: CHAIN, poolId: POOL, ca: CA, quote: '0xusdg', quoteSymbol: 'USDG',
  quoteDecimals: 6, tokenIs0: true, tokenDecimals: 18,
};
/**
 * token 18 位、quote 6 位：priceFromSqrtX96 会把 pRaw 乘以 10^(18-6)，
 * 所以要反过来先除，才能构造出目标价 p。
 */
const sqrtFor = (p: number) => BigInt(Math.round(Math.sqrt(p / 10 ** 12) * 2 ** 96));

/**
 * 搭一条完整的链路：真实事件 → 定价 → 1m/15m K 线 → 形态 → 叙事门 → 信号 → outbox。
 * 价格序列复用二段的合成 fixture 形状（第一波 3× → 回撤 → 50h 箱体）。
 */
function seed(prices: number[], stepMs: number) {
  db.prepare(`INSERT INTO post_pools (chain_id,pool_id,ca,quote,quote_symbol,quote_decimals,token_is0,token_decimals,init_block,init_ts)
    VALUES (?,?,?,?,?,?,1,18,1,?)`).run(CHAIN, POOL, CA, pool.quote, 'USDG', 6, T0 - stepMs);
  db.prepare(`INSERT INTO post_tokens (chain_id, ca, symbol, first_seen_at, tier, age_quality)
    VALUES (?,?,?,?, 'hot', 'verified')`).run(CHAIN, CA, 'E2E', T0 - stepMs);
  // 供应量时点快照：箱体中位价 ≈ 0.0021，×2e9 → FDV ≈ $4.2M，落在 3–5M 区间
  recordSupply(CHAIN, CA, 1, 2_000_000_000n * 10n ** 18n, 18, T0 - stepMs, T0 - stepMs, 'test');

  const events: SwapEvent[] = prices.map((p, i) => ({
    chainId: CHAIN, poolId: POOL, blockNumber: 1000 + i,
    blockHash: `0xb${i}`, txHash: `0xt${i}`, txIndex: 0, logIndex: 0,
    eventTs: T0 + i * stepMs + 1000, observedAt: T0 + i * stepMs + 1000,
    amount0: -(10n ** 18n), amount1: 10n ** 6n, sqrtPriceX96: sqrtFor(p),
  }));
  ingestSwaps(events, pool);
  const lastTs = T0 + prices.length * stepMs;
  recordInterval(CHAIN, POOL, 'realtime', 1000, 1000 + prices.length, T0 - stepMs, lastTs + stepMs, 'complete');
  // 实时扫描是对 PoolManager 整体做的，所以还要记一条全链级覆盖——
  // firstTradeOf 用它判断「建池是否在我们的覆盖范围内」（老币重建池会被判 age_unverified）。
  recordInterval(CHAIN, '*', 'realtime', 1, 1000 + prices.length, T0 - 2 * stepMs, lastTs + stepMs, 'complete');
  return lastTs;
}

function build(lastTs: number) {
  const s = createSeries(CHAIN, CA, POOL, T0 - MIN);
  const ref = { seriesId: s.seriesId, chainId: CHAIN, ca: CA, poolId: POOL };
  const opt = { watermarkTs: lastTs + 10 * MIN, graceSeconds: 5, source: 'fixture' };
  buildMinuteCandles(ref, loadSwaps(POOL, T0 - MIN, lastTs + MIN), T0 - MIN, lastTs + MIN, opt);
  rollUp(ref, 900, T0 - MIN, lastTs + MIN, opt);
  return s.seriesId;
}

function passingNarrative(availableAt: number) {
  saveReport({
    reportId: 'N-e2e', chainId: CHAIN, ca: CA, version: 1,
    analyzedAt: availableAt, availableAt, validUntil: availableAt + 6 * 3600_000,
    status: 'pass', category: 'science', summary: '某具体研究的 meme 延伸',
    caBinding: 'verified', novelty: 'new_in_index', marketResonance: 'supported',
    previousSameChainExamples: [],
    claims: [
      { statement: 'a', url: 'https://example.org/a', excerpt: null, publishedAt: null, fetchedAt: availableAt, verified: true, independent: true },
      { statement: 'b', url: 'https://example.net/b', excerpt: null, publishedAt: null, fetchedAt: availableAt, verified: true, independent: true },
    ],
    modelId: null, promptVersion: null, inputHash: null, corpusVersion: null,
    confidenceLabel: null, reviewer: 'human', reasonCodes: ['ok'],
  });
}

/**
 * 第一波 3× → 回撤 33% → 横 48.25h（15m 周期）。
 *
 * 刻意让 READY 落在**数据末尾附近**：READY 的发送期限是确认后 30 分钟，
 * 如果箱体一路横到 50h 才评估，那条 READY 在确认两小时后才被处理，
 * outbox 会按期限归档而不是补发成实时信号——那是正确行为，但测不出发送链路。
 */
function secondLegPrices(): number[] {
  const ramp = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + (b - a) * (i / (n - 1)));
  const osc = (lo: number, hi: number, n: number, period = 16) => Array.from({ length: n }, (_, i) => {
    const ph = (i % period) / period;
    return ph < 0.5 ? lo + (hi - lo) * ph * 2 : hi - (hi - lo) * (ph - 0.5) * 2;
  });
  return [...Array(4).fill(0.001), ...ramp(0.0012, 0.003, 8), 0.0024, 0.002, ...osc(0.0018, 0.0024, Math.round(48.25 * 4), 16)];
}

function ctxFor(seriesId: string, asOf: number, dryRun = false): EvaluationContext {
  const { config, hash } = postConfig();
  const ft = firstTradeOf(CHAIN, CA);
  return {
    cfg: config, configHash: hash, chainId: CHAIN, ca: CA, symbol: 'E2E', seriesId,
    firstTradeTs: ft.ts, ageQuality: ft.quality,
    asOf, watermarkTs: asOf, mode: 'off', runId: 'live', dryRun,
  };
}

test('端到端：链上事件 → K 线 → 二段 READY → 信号 → outbox → off 出口送达', async () => {
  const prices = secondLegPrices();
  const lastTs = seed(prices, 15 * MIN);
  const seriesId = build(lastTs);
  passingNarrative(lastTs);   // 叙事有 6h TTL，必须在触发时点附近可用

  const asOf = lastTs + MIN;
  const out = evaluateEpisodes(ctxFor(seriesId, asOf));

  assert.ok(out.secondLeg, '必须跑出二段结果');
  assert.equal(out.secondLeg!.phase, 'READY', `${out.secondLeg!.reason}｜跳过: ${out.skipped.join('；')}`);
  const ready = out.signals.filter(s => s.eventType === 'SECOND_LEG_READY');
  assert.equal(ready.length, 1, `应产生一条 READY 信号，实际 ${out.signals.length} 条：${out.skipped.join('；')}`);
  assert.match(ready[0]!.text, /二段观察就绪/);
  assert.match(ready[0]!.text, /3–5M 口径/);
  assert.match(ready[0]!.text, new RegExp(CA));

  // 走一遍 outbox
  const t = lease('off', asOf)!;
  assert.ok(t, 'READY 必须进入 outbox');
  const r = await dispatch(t, offPort(), asOf);
  assert.equal(r.state, 'sent');
  assert.equal(outboxStats().sent, 1);
});

test('同一份数据重复评估不会产生第二条通知', () => {
  const lastTs = seed(secondLegPrices(), 15 * MIN);
  const seriesId = build(lastTs);
  passingNarrative(lastTs);   // 叙事有 6h TTL，必须在触发时点附近可用
  const asOf = lastTs + MIN;

  evaluateEpisodes(ctxFor(seriesId, asOf));
  const before = (db.prepare('SELECT COUNT(*) n FROM post_outbox').get() as any).n;
  evaluateEpisodes(ctxFor(seriesId, asOf));
  evaluateEpisodes(ctxFor(seriesId, asOf));
  const after = (db.prepare('SELECT COUNT(*) n FROM post_outbox').get() as any).n;
  assert.equal(after, before, '重复处理同一闭合桶不得新增通知任务');
});

test('叙事未核验时形态成立也不发 TG，但 evaluation 必须留下原因', () => {
  const lastTs = seed(secondLegPrices(), 15 * MIN);
  const seriesId = build(lastTs);
  // 故意不导入叙事报告
  const out = evaluateEpisodes(ctxFor(seriesId, lastTs + MIN));
  assert.equal(out.secondLeg!.phase, 'READY');
  assert.equal(out.signals.length, 0, '叙事门未通过就不能发卡');
  assert.ok(out.skipped.some(s => s.includes('SECOND_LEG_READY 未发')));
  const rows = db.prepare("SELECT rule, result FROM post_evaluations WHERE rule LIKE 'narrative%'").all() as any[];
  assert.ok(rows.length, '叙事判定必须落库，才能回答「为什么没推」');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM post_outbox').get() as any).n, 0);
});

test('重复题材：二段不发标准 READY', () => {
  const lastTs = seed(secondLegPrices(), 15 * MIN);
  const seriesId = build(lastTs);
  saveReport({
    reportId: 'N-rep', chainId: CHAIN, ca: CA, version: 1,
    analyzedAt: lastTs, availableAt: lastTs, validUntil: lastTs + 1e12,
    status: 'watch', category: 'science', summary: '旧题材',
    caBinding: 'verified', novelty: 'repeated', marketResonance: 'supported',
    previousSameChainExamples: [{ ca: '0xold', firstObservedAt: lastTs - 1e9, concept: '同一研究', evidence: 'x' }],
    claims: [], modelId: null, promptVersion: null, inputHash: null, corpusVersion: null,
    confidenceLabel: null, reviewer: 'human', reasonCodes: ['repeated'],
  });
  const out = evaluateEpisodes(ctxFor(seriesId, lastTs + MIN));
  assert.equal(out.signals.filter(s => s.eventType === 'SECOND_LEG_READY').length, 0);
});

test('新币两次回拉：1m 链路端到端到 outbox', async () => {
  const prices = [
    0.001, 0.001, 0.001, 0.001, 0.001,
    0.0012, 0.0016, 0.002,
    0.00185, 0.00175, 0.0017,
    0.00178, 0.00186, 0.00192,
    0.00188, 0.0018, 0.00172, 0.00165,
    0.00172, 0.00179, 0.00185,
  ];
  const lastTs = seed(prices, MIN);
  const seriesId = build(lastTs);
  passingNarrative(lastTs);   // 叙事有 6h TTL，必须在触发时点附近可用

  const asOf = lastTs + 5 * MIN;
  const out = evaluateEpisodes(ctxFor(seriesId, asOf));
  assert.ok(out.newPullback, '必须跑出新币结果');
  assert.equal(out.newPullback!.phase, 'CONFIRMED', out.newPullback!.reason);
  const confirmed = out.signals.filter(s => s.eventType === 'NEW_PULLBACK_CONFIRMED');
  assert.equal(confirmed.length, 1);
  assert.match(confirmed[0]!.text, /新币两次回拉确认/);

  const t = lease('off', asOf)!;
  const r = await dispatch(t, offPort(), asOf);
  assert.equal(r.state, 'sent');
});

test('dryRun 只返回会发什么，不写 outbox', () => {
  const lastTs = seed(secondLegPrices(), 15 * MIN);
  const seriesId = build(lastTs);
  passingNarrative(lastTs);   // 叙事有 6h TTL，必须在触发时点附近可用
  const out = evaluateEpisodes(ctxFor(seriesId, lastTs + MIN, true));
  assert.ok(out.signals.length > 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM post_outbox').get() as any).n, 0);
});

test('币龄证据不足时新币分支不触发（老币重建池不当新币）', () => {
  const lastTs = seed([0.001, 0.001, 0.001, 0.001, 0.001, 0.002, 0.0017, 0.0019], MIN);
  const seriesId = build(lastTs);
  const ctx = { ...ctxFor(seriesId, lastTs + 5 * MIN), ageQuality: 'age_unverified' as const };
  const out = evaluateEpisodes(ctx);
  assert.equal(out.newPullback!.phase, 'PENDING_HISTORY');
  assert.equal(out.signals.length, 0);
});
