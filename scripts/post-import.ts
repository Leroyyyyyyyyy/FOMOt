/**
 * 人工导入：叙事报告、题材、手动 CA、外部候选、持仓参考价。
 *
 *   npm run post:import -- --file <validated-json> [--dry-run]
 *
 * 文件格式（任一段可省略）：
 * {
 *   "narratives": [ …NarrativeReport… ],
 *   "topics":     [ { topicId, chainId, category, concept, firstObservedAt, availableAt, coverageNote, … } ],
 *   "topicLinks": [ { topicId, chainId, ca, linkedAt, similarityReason, evidence, outcome } ],
 *   "tokens":     [ { chainId, ca, note } ],                       // 手动关注的 CA
 *   "external":   [ { chainId, ca, signal, sourceEventId, evidenceRef, … } ],
 *   "referenceEntries": [ { chainId, ca, entryTs, priceUsd, quantity, note } ]
 * }
 *
 * 所有条目都必须过运行时校验；有任何一条不合法就整体不写库（一个事务）。
 * 导入的内容是**数据**，不是指令：文件里写什么都不会改变判定逻辑。
 */
import { readFileSync } from 'node:fs';
import { db } from '../src/db.js';
import { migratePostSchema } from '../src/post/store.js';
import { validateReport, saveReport, recordTopic, linkTopic, safeUrl } from '../src/post/narrative.js';
import { normalizeExternalCandidate } from '../src/post/providers/debot.js';

migratePostSchema();

const fileIdx = process.argv.indexOf('--file');
if (fileIdx < 0 || !process.argv[fileIdx + 1]) {
  console.error('用法: npm run post:import -- --file <validated-json> [--dry-run]');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const path = process.argv[fileIdx + 1]!;

let doc: any;
try { doc = JSON.parse(readFileSync(path, 'utf8')); }
catch (err) { console.error(`读取/解析失败: ${String(err).slice(0, 200)}`); process.exit(1); }

const errors: string[] = [];
const now = Date.now();
const reports: any[] = [];
const topics: any[] = [];
const links: any[] = [];
const tokens: any[] = [];
const external: any[] = [];
const refs: any[] = [];

for (const [i, raw] of (doc.narratives ?? []).entries()) {
  const v = validateReport(raw);
  if (v.errors.length) errors.push(...v.errors.map(e => `narratives[${i}]: ${e}`));
  else reports.push(v.report);
}

for (const [i, t] of (doc.topics ?? []).entries()) {
  for (const k of ['topicId', 'category', 'concept', 'coverageNote'] as const) {
    if (typeof t?.[k] !== 'string' || !t[k]) errors.push(`topics[${i}].${k} 必须是非空字符串`);
  }
  if (!Number.isInteger(t?.chainId)) errors.push(`topics[${i}].chainId 必须是整数`);
  for (const k of ['firstObservedAt', 'availableAt'] as const) {
    if (typeof t?.[k] !== 'number') errors.push(`topics[${i}].${k} 必须是毫秒时间戳`);
  }
  if (t?.concept && String(t.concept).trim().length < 4) {
    errors.push(`topics[${i}].concept 太宽泛：需要具体概念实体（如「某具体果蝇脑模拟研究」），不能只写「AI」`);
  }
  topics.push(t);
}

for (const [i, l] of (doc.topicLinks ?? []).entries()) {
  if (typeof l?.topicId !== 'string' || !l.topicId) errors.push(`topicLinks[${i}].topicId 必须是非空字符串`);
  if (typeof l?.ca !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(l.ca)) errors.push(`topicLinks[${i}].ca 地址格式不对`);
  if (typeof l?.linkedAt !== 'number') errors.push(`topicLinks[${i}].linkedAt 必须是毫秒时间戳`);
  links.push(l);
}

for (const [i, t] of (doc.tokens ?? []).entries()) {
  if (!Number.isInteger(t?.chainId)) errors.push(`tokens[${i}].chainId 必须是整数`);
  if (typeof t?.ca !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(t.ca)) errors.push(`tokens[${i}].ca 地址格式不对`);
  tokens.push(t);
}

for (const [i, e] of (doc.external ?? []).entries()) {
  const v = normalizeExternalCandidate(e, now);
  if (v.errors.length) errors.push(...v.errors.map(x => `external[${i}]: ${x}`));
  else external.push(v.candidate);
}

for (const [i, r] of (doc.referenceEntries ?? []).entries()) {
  if (!Number.isInteger(r?.chainId)) errors.push(`referenceEntries[${i}].chainId 必须是整数`);
  if (typeof r?.ca !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.ca)) errors.push(`referenceEntries[${i}].ca 地址格式不对`);
  if (typeof r?.entryTs !== 'number' || typeof r?.priceUsd !== 'number' || !(r.priceUsd > 0)) {
    errors.push(`referenceEntries[${i}] 必须有毫秒 entryTs 和正的 priceUsd`);
  }
  refs.push(r);
}

if (errors.length) {
  console.error(`✗ ${path} 校验不通过，未写入任何数据：\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const summary = {
  叙事报告: reports.length, 题材: topics.length, 题材关联: links.length,
  手动CA: tokens.length, 外部候选: external.length, 持仓参考: refs.length,
};
if (dryRun) {
  console.log('✓ 校验通过（--dry-run，未写库）');
  console.log(summary);
  process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
try {
  for (const r of reports) saveReport(r);
  for (const t of topics) recordTopic({
    topicId: t.topicId, chainId: t.chainId, category: t.category, concept: t.concept,
    eventKey: t.eventKey ?? null, firstObservedAt: t.firstObservedAt,
    sourcePublishedAt: t.sourcePublishedAt ?? null, availableAt: t.availableAt,
    coverageNote: t.coverageNote, evidence: t.evidence ? JSON.stringify(t.evidence) : null,
  });
  for (const l of links) linkTopic(l.topicId, l.chainId, l.ca, l.linkedAt,
    l.similarityReason ?? '人工导入', l.evidence ? JSON.stringify(l.evidence) : null, l.outcome ?? null);

  const upsertToken = db.prepare(
    `INSERT INTO post_tokens (chain_id, ca, first_seen_at, tier, age_quality)
     VALUES (?,?,?, 'warm', 'unknown') ON CONFLICT(chain_id, ca) DO UPDATE SET tier='warm'`,
  );
  const insDiscovery = db.prepare(
    `INSERT INTO post_discoveries (source, source_event_id, chain_id, ca, event_ts, observed_at, available_at, evidence_ref, payload)
     VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
  );
  for (const t of tokens) {
    upsertToken.run(t.chainId, t.ca.toLowerCase(), now);
    insDiscovery.run('manual', `manual:${t.ca.toLowerCase()}:${now}`, t.chainId, t.ca.toLowerCase(),
      null, now, now, t.note ?? '人工导入 CA', JSON.stringify(t));
  }
  for (const c of external) {
    upsertToken.run(c.chainId, c.ca, now);
    insDiscovery.run('debot', c.sourceEventId, c.chainId, c.ca, c.eventTs, c.observedAt, c.availableAt,
      c.evidenceRef, JSON.stringify({ signal: c.signal, wallets: c.wallets, raw: c.raw }));
  }
  const insRef = db.prepare(
    `INSERT INTO post_reference_entries (chain_id, ca, entry_ts, price_usd, quantity, note, imported_at)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(chain_id, ca, entry_ts) DO UPDATE SET
       price_usd=excluded.price_usd, quantity=excluded.quantity, note=excluded.note`,
  );
  for (const r of refs) insRef.run(r.chainId, r.ca.toLowerCase(), r.entryTs, r.priceUsd, r.quantity ?? null, r.note ?? null, now);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`写入失败，已整体回滚: ${String(err).slice(0, 300)}`);
  process.exit(1);
}

console.log('✓ 导入完成');
console.log(summary);
for (const r of reports) {
  const bad = r.claims.filter((c: any) => c.url && !safeUrl(c.url)).length;
  console.log(`  ${r.reportId} ${r.ca} status=${r.status} caBinding=${r.caBinding} novelty=${r.novelty}` +
    (bad ? `（${bad} 条 URL 被拒）` : ''));
}
console.log('\n提示：导入的叙事只是**候选判断**，最终 pass/watch/unknown 由程序按 §9.1 重新判定。');
