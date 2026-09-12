/**
 * 逐时间回放（设计文档 §13 阶段 5 / §14「无前视」）。
 *
 *   npm run post:replay -- --fixture <path.json> --as-of <ISO> --output <dir> [--step-bars 1]
 *
 * 硬约束：
 *   - **内部强制 NOTIFY_MODE=off**，外部设 telegram 也覆盖不了；
 *   - 用 `--output` 下的独立临时库，绝不读写 data/fomot.db；
 *   - 每个回放有自己的 runId，不污染 live 的 episode / outbox；
 *   - 把数据截断到每个 asOf 再跑一遍，断言结果与逐桶推进一致（无前视）。
 *
 * fixture 格式（明确标注是真实历史还是合成数据）：
 * {
 *   "note": "synthetic | real-history",
 *   "chainId": 4663, "ca": "0x…", "poolId": "0x…",
 *   "quoteSymbol": "USDG", "quoteDecimals": 6, "tokenIs0": true, "tokenDecimals": 18,
 *   "supply": { "totalSupply": "1000000000000000000000000000", "decimals": 18, "observedTs": 0 },
 *   "timeframeSec": 900,
 *   "bars": [ { "closeTs": 0, "close": 0.001, "kind": "real|synthetic|unknown", "swaps": 5, "volumeUsd": 100 } ],
 *   "narrative": { …NarrativeReport… }   // 可选
 * }
 */
process.env.NOTIFY_MODE = 'off';      // 必须在 import 任何模块之前
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const fixturePath = arg('fixture');
if (!fixturePath) {
  console.error('用法: npm run post:replay -- --fixture <path.json> [--as-of <ISO>] [--output <dir>]');
  process.exit(1);
}
const outDir = resolve(arg('output') ?? mkdtempSync(join(tmpdir(), 'post-replay-')));
mkdirSync(outDir, { recursive: true });
// 独立临时库：回放绝不碰日常运行的数据
process.env.FOMOT_DB = join(outDir, 'replay.db');

const { db } = await import('../src/db.js');
const { migratePostSchema } = await import('../src/post/store.js');
const { postConfig } = await import('../src/post/config.js');
const { createSeries } = await import('../src/post/market/series.js');
const { recordSupply } = await import('../src/post/market/supply.js');
const { recordInterval } = await import('../src/post/market/coverage.js');
const { saveReport, validateReport } = await import('../src/post/narrative.js');
const { evaluateEpisodes } = await import('../src/post/run.js');
const { outboxStats } = await import('../src/post/outbox.js');

migratePostSchema();
const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));
const runId = `replay-${Date.now()}`;
const { config, hash } = postConfig();

if (!fx.note || !['synthetic', 'real-history'].includes(fx.note)) {
  console.error('fixture 必须显式声明 note 为 "synthetic" 或 "real-history"——' +
    '合成数据不能冒充实测历史（设计文档 §2.3）');
  process.exit(1);
}

const chainId = fx.chainId, ca = String(fx.ca).toLowerCase(), poolId = fx.poolId;
const tf = fx.timeframeSec ?? 900;

db.prepare(`INSERT INTO post_pools (chain_id,pool_id,ca,quote,quote_symbol,quote_decimals,token_is0,token_decimals,init_block,init_ts)
  VALUES (?,?,?,?,?,?,?,?,1,?) ON CONFLICT DO NOTHING`)
  .run(chainId, poolId, ca, fx.quote ?? '0x0', fx.quoteSymbol ?? 'USDG', fx.quoteDecimals ?? 6,
    fx.tokenIs0 ? 1 : 0, fx.tokenDecimals ?? 18, fx.bars[0].closeTs - tf * 1000);
db.prepare(`INSERT INTO post_tokens (chain_id, ca, symbol, first_seen_at, tier, age_quality)
  VALUES (?,?,?,?, 'hot', 'verified') ON CONFLICT DO NOTHING`)
  .run(chainId, ca, fx.symbol ?? null, fx.bars[0].closeTs);

if (fx.supply) {
  recordSupply(chainId, ca, 1, BigInt(fx.supply.totalSupply), fx.supply.decimals,
    fx.supply.observedTs ?? fx.bars[0].closeTs, fx.supply.observedTs ?? fx.bars[0].closeTs, 'fixture');
}
if (fx.narrative) {
  const v = validateReport(fx.narrative);
  if (v.errors.length) { console.error('fixture 里的叙事报告不合法:', v.errors); process.exit(1); }
  saveReport(v.report!);
}

const firstTs = fx.bars[0].closeTs - tf * 1000;
const lastTs = fx.bars[fx.bars.length - 1].closeTs;
recordInterval(chainId, poolId, 'replay' as any, 1, 1 + fx.bars.length, firstTs, lastTs + tf * 1000, 'complete');
recordInterval(chainId, '*', 'replay' as any, 1, 1 + fx.bars.length, firstTs, lastTs + tf * 1000, 'complete');

const series = createSeries(chainId, ca, poolId, firstTs);
const supply = fx.supply ? Number(BigInt(fx.supply.totalSupply)) / 10 ** fx.supply.decimals : null;

const insCandle = db.prepare(
  `INSERT INTO post_candles (series_id, timeframe_sec, open_ts, close_ts, available_at,
     open, high, low, close, volume_usd, swaps, fdv_close_usd, closed, synthetic, quality, source, quote_quality, revision)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,1)
   ON CONFLICT(series_id, timeframe_sec, open_ts) DO NOTHING`,
);
for (const b of fx.bars) {
  const kind = b.kind ?? 'real';
  const openTs = b.closeTs - tf * 1000;
  insCandle.run(series.seriesId, tf, openTs, b.closeTs, b.closeTs,
    kind === 'unknown' ? null : (b.open ?? b.close), kind === 'unknown' ? null : (b.high ?? b.close),
    kind === 'unknown' ? null : (b.low ?? b.close), kind === 'unknown' ? null : b.close,
    kind === 'unknown' ? null : (b.volumeUsd ?? (kind === 'synthetic' ? 0 : 100)),
    kind === 'real' ? (b.swaps ?? 5) : 0,
    kind === 'unknown' || supply === null ? null : b.close * supply,
    kind === 'synthetic' ? 1 : 0,
    kind === 'unknown' ? 'unknown' : 'complete',
    `fixture:${fx.note}`, 'historical');
}

const ctxAt = (asOf: number) => ({
  cfg: config, configHash: hash, chainId, ca, symbol: fx.symbol ?? null, seriesId: series.seriesId,
  firstTradeTs: firstTs, ageQuality: 'verified' as const,
  asOf, watermarkTs: asOf, mode: 'off' as const, runId, dryRun: true,
});

// ── 逐桶推进：记录每个事件第一次出现的时间
const stepBars = Number(arg('step-bars', '1'));
const timeline: { asOf: number; phase: string; events: string[] }[] = [];
const firstSeen = new Map<string, number>();
for (let i = 0; i < fx.bars.length; i += stepBars) {
  const asOf = fx.bars[i].closeTs;
  const out = evaluateEpisodes(ctxAt(asOf));
  const events = [
    ...(out.secondLeg?.events ?? []).map(e => e.type),
    ...(out.newPullback?.events ?? []).map(e => e.type),
    ...(out.million?.events ?? []).map(e => e.type),
  ];
  for (const e of events) if (!firstSeen.has(e)) firstSeen.set(e, asOf);
  timeline.push({ asOf, phase: out.secondLeg?.phase ?? out.newPullback?.phase ?? 'n/a', events });
}

// ── 无前视断言：整段跑一遍，事件时间必须与逐桶推进一致
const full = evaluateEpisodes(ctxAt(arg('as-of') ? Date.parse(arg('as-of')!) : lastTs));
const fullEvents = [
  ...(full.secondLeg?.events ?? []),
  ...(full.newPullback?.events ?? []),
  ...(full.million?.events ?? []),
];
const violations: string[] = [];
for (const e of fullEvents) {
  const seen = firstSeen.get(e.type);
  if (seen === undefined) { violations.push(`${e.type} 只在整段跑里出现，逐桶推进时没出现过`); continue; }
  if (e.barCloseTs < seen) violations.push(`${e.type} 的确认时间 ${new Date(e.barCloseTs).toISOString()} 早于逐桶首次可见 ${new Date(seen).toISOString()}（前视）`);
}

const report = {
  fixture: fixturePath,
  fixtureKind: fx.note,
  runId, configHash: hash,
  notifyMode: process.env.NOTIFY_MODE,
  dbPath: process.env.FOMOT_DB,
  bars: fx.bars.length,
  timeframeSec: tf,
  finalPhase: {
    secondLeg: full.secondLeg?.phase ?? null,
    newPullback: full.newPullback?.phase ?? null,
    million: full.million?.phase ?? null,
  },
  firstSeen: Object.fromEntries([...firstSeen].map(([k, v]) => [k, new Date(v).toISOString()])),
  events: fullEvents.map(e => ({ type: e.type, at: new Date(e.barCloseTs).toISOString(), reason: e.reason })),
  skipped: full.skipped,
  evaluations: full.evaluations.map(e => ({ rule: e.rule, result: e.result, reason: e.reason })),
  lookaheadViolations: violations,
  outbox: outboxStats(runId),
};
writeFileSync(join(outDir, 'replay-report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));

console.log(`\n回放完成（fixture 类型: ${fx.note}）`);
console.log(`  独立库    ${process.env.FOMOT_DB}`);
console.log(`  runId     ${runId}（不污染 live）`);
console.log(`  通知模式  ${process.env.NOTIFY_MODE}（内部强制 off，外部覆盖不了）`);
console.log(`  终态      二段=${report.finalPhase.secondLeg} 新币=${report.finalPhase.newPullback} 关口=${report.finalPhase.million}`);
console.log(`  事件      ${report.events.length} 条`);
for (const e of report.events) console.log(`    ${e.at} ${e.type} — ${e.reason}`);
if (report.skipped.length) { console.log('  未发原因：'); for (const s of report.skipped) console.log(`    · ${s}`); }
console.log(`  outbox    ${JSON.stringify(report.outbox)}（dryRun，不入队）`);
if (violations.length) {
  console.error(`\n❌ 检出 ${violations.length} 处前视：`);
  for (const v of violations) console.error(`   ${v}`);
  console.error(`\n报告已写入 ${outDir}`);
  process.exit(1);
}
console.log(`\n✅ 无前视检查通过：截断回放与逐桶推进的事件时间一致`);
console.log(`报告已写入 ${outDir}\n`);
