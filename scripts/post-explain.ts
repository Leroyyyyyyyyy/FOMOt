/**
 * 逐条解释某个代币现在的判定结果：
 *
 *   npm run post:explain -- --chain 4663 --ca <CA> [--as-of <ISO>] [--run live]
 *
 * 输出每条规则的 pass / fail / unknown 及原因，回答「为什么没推」。
 * 只读数据库，不连 RPC、不发消息。
 */
import { db } from '../src/db.js';
import { migratePostSchema } from '../src/post/store.js';
import { postConfig } from '../src/post/config.js';
import { loadCandles, realBarRatio } from '../src/post/market/candles.js';
import { coverageOf, openGaps } from '../src/post/market/coverage.js';
import { evaluateEpisodes, type EvaluationContext } from '../src/post/run.js';
import { firstTradeOf, candidate } from '../src/post/discovery.js';
import { latestReport, decideNarrative } from '../src/post/narrative.js';
import type { Timeframe } from '../src/post/types.js';

migratePostSchema();

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const chainId = Number(arg('chain', '4663'));
const ca = (arg('ca') ?? '').toLowerCase();
const runId = arg('run', 'live')!;
const asOf = arg('as-of') ? Date.parse(arg('as-of')!) : Date.now();

if (!/^0x[0-9a-f]{40}$/.test(ca)) {
  console.error('用法: npm run post:explain -- --chain 4663 --ca 0x… [--as-of 2026-09-12T10:00:00Z]');
  process.exit(1);
}

const { config, hash } = postConfig();
const icon = (r: string) => (r === 'pass' ? '✅' : r === 'fail' ? '❌' : '⚠️ ');
const line = (s = '─') => console.log(s.repeat(72));

console.log(`\npost_v1 判定解释 · chain ${chainId} · ${ca}`);
console.log(`asOf ${new Date(asOf).toISOString()} · configHash ${hash} · runId ${runId}`);
line();

// ── 候选状态
const c = candidate(chainId, ca);
if (!c) {
  console.log('❌ 这个 CA 还没有进入 post 候选注册表。');
  console.log('   可能原因：链上还没发现它的可计价池，或者还没跑过 post 模式采集。');
  console.log('   人工关注可以用: npm run post:import -- --file <含 tokens 段的 json>');
  process.exit(0);
}
const ft = firstTradeOf(chainId, ca);
console.log(`候选分层    ${c.tier}`);
console.log(`币龄证据    ${ft.quality}：${ft.evidence}`);
console.log(`最早成交    ${ft.ts ? new Date(ft.ts).toISOString() : 'n/a'}`);
console.log(`跟踪截止    ${c.trackUntil ? new Date(c.trackUntil).toISOString() : 'n/a'}`);

// ── series 与数据完整度
const series = db.prepare(
  `SELECT * FROM post_series WHERE chain_id=? AND ca=? ORDER BY started_at DESC LIMIT 1`,
).get(chainId, ca) as any;
line();
if (!series) {
  console.log('❌ 还没有冻结主池 / series——没有 series 就没有 K 线，形态无从谈起。');
  process.exit(0);
}
console.log(`series      ${series.series_id}`);
console.log(`主池        ${series.pool_id}（${series.ended_at ? '已终结：' + series.end_reason : '进行中'}）`);

for (const tf of [60, 900] as Timeframe[]) {
  const bars = loadCandles(series.series_id, tf, asOf - 120 * 3600_000, asOf + tf * 1000, { asOf });
  const unknown = bars.filter(b => b.quality === 'unknown').length;
  const synth = bars.filter(b => b.synthetic).length;
  console.log(`${tf === 60 ? '1m ' : '15m'} K 线    共 ${bars.length} 根 · 真实成交占比 ${(realBarRatio(bars) * 100).toFixed(0)}%` +
    ` · synthetic ${synth} · unknown ${unknown}`);
}
const cov = coverageOf(chainId, series.pool_id, asOf - 3600_000, asOf);
console.log(`最近 1h 覆盖 ${cov}`);
const gaps = openGaps(chainId, 5);
if (gaps.length) {
  console.log(`⚠️  未补的缺口 ${gaps.length} 段（缺口补齐前不得发形态确认）：`);
  for (const g of gaps) console.log(`    block ${g.fromBlock}-${g.toBlock} ${g.note ?? ''}`);
}

// ── 叙事
line();
const report = latestReport(chainId, ca, asOf);
const narrative = decideNarrative(report, config.narrative as any, asOf);
console.log(`叙事判定    ${icon(narrative.status)} ${narrative.status}` +
  (narrative.speculativeOnly ? '（重复题材：二段不发标准 READY，B/C 只能发观察卡）' : ''));
if (report) {
  console.log(`  报告      ${report.reportId} v${report.version} reviewer=${report.reviewer}`);
  console.log(`  概念      ${report.summary}`);
}
for (const e of narrative.evaluations) console.log(`  ${icon(e.result)} ${e.rule.padEnd(24)} ${e.reason}`);

// ── 形态与门（dryRun：只算不写库、不入队）
line();
const ctx: EvaluationContext = {
  cfg: config, configHash: hash, chainId, ca, symbol: c.symbol, seriesId: series.series_id,
  firstTradeTs: ft.ts, ageQuality: ft.quality,
  asOf, watermarkTs: asOf, mode: 'off', runId, dryRun: true,
};
const out = evaluateEpisodes(ctx);

if (out.secondLeg) {
  console.log(`二段        ${out.secondLeg.phase} — ${out.secondLeg.reason}`);
  if (out.secondLeg.box) {
    const b = out.secondLeg.box;
    console.log(`  箱体      ${b.lower.toPrecision(4)}–${b.upper.toPrecision(4)}` +
      ` 宽度 ${b.width.toFixed(3)} 漂移 ${b.slope24h.toFixed(3)} 往返 ${out.secondLeg.zoneVisits} 次`);
  }
}
if (out.newPullback) console.log(`新币回拉    ${out.newPullback.phase} — ${out.newPullback.reason}`);
if (out.million) console.log(`百万关口    ${out.million.phase} — ${out.million.reason}`);

line();
console.log('逐条规则：');
const seen = new Set<string>();
for (const e of out.evaluations) {
  const key = `${e.rule}|${e.result}|${e.reason}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${icon(e.result)} ${e.rule.padEnd(30)} ${e.reason}`);
  if (e.observed !== null && e.observed !== undefined) {
    console.log(`      观测=${JSON.stringify(e.observed)} 门槛=${JSON.stringify(e.threshold)}`);
  }
}

if (out.skipped.length) {
  line();
  console.log('本轮未发的原因：');
  for (const s of out.skipped) console.log(`  · ${s}`);
}

line();
console.log('已产生的信号（历史）：');
const sigs = db.prepare(
  `SELECT event_type, confirmed_at, quality, signal_id FROM post_signals
   WHERE chain_id=? AND ca=? AND run_id=? ORDER BY confirmed_at DESC LIMIT 20`,
).all(chainId, ca, runId) as any[];
if (!sigs.length) console.log('  （无）');
for (const s of sigs) {
  const ob = db.prepare('SELECT state, last_error FROM post_outbox WHERE signal_id=? ORDER BY updated_at DESC LIMIT 1')
    .get(s.signal_id) as any;
  console.log(`  ${new Date(s.confirmed_at).toISOString()} ${s.event_type.padEnd(26)} ${s.signal_id} ` +
    `[outbox ${ob?.state ?? 'n/a'}${ob?.last_error ? ': ' + String(ob.last_error).slice(0, 60) : ''}]`);
}
console.log();
