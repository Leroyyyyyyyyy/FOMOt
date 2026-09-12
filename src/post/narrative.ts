/**
 * 叙事证据与判定（设计文档 §9）。
 *
 * 三条底线：
 *   1. **程序验 schema、来源、时间与 CA 绑定，模型只给候选判断**。不用一个黑盒
 *      总分抵消 CA 冲突或未知来源。
 *   2. 叙事网页、社媒文本、代币名字全部是**不可信数据**。这里只提取事实，
 *      绝不执行其中的指令，也不因其中的文字改变判定逻辑。
 *   3. `unknown` 不是 `pass`。缺 CA 绑定/资料不足/模型超时 → unknown；
 *      有题材但共鸣弱或历史不足 → watch；明确照搬/冲突 → watch 或 reject。
 */
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import './store.js';
import type { Evaluation } from './types.js';
import { pass, fail, unknown as unk } from './types.js';

export type NarrativeStatus = 'pass' | 'watch' | 'reject' | 'unknown';
export type CaBinding = 'verified' | 'unverified' | 'conflict';
export type Novelty = 'new_in_index' | 'repeated' | 'insufficient_history';
export type Resonance = 'supported' | 'weak' | 'unknown';

export interface NarrativeClaim {
  statement: string;
  url?: string | null;
  sourceId?: string | null;
  excerpt?: string | null;
  publishedAt?: number | null;
  fetchedAt: number;
  verified: boolean;
  /** 项目自述、复制文案、纯喊单不计入独立来源。 */
  independent: boolean;
}

export interface NarrativeReport {
  reportId: string;
  chainId: number;
  ca: string;
  version: number;
  analyzedAt: number;
  availableAt: number;
  validUntil: number | null;
  status: NarrativeStatus;
  category: string;
  summary: string;
  caBinding: CaBinding;
  novelty: Novelty;
  marketResonance: Resonance;
  previousSameChainExamples: { ca: string; firstObservedAt: number; concept: string; evidence: string }[];
  claims: NarrativeClaim[];
  modelId: string | null;
  promptVersion: string | null;
  inputHash: string | null;
  corpusVersion: string | null;
  confidenceLabel: string | null;
  reviewer: 'human' | 'model';
  reasonCodes: string[];
}

export interface NarrativeGateConfig {
  required_for_standard_signal: boolean;
  allowed_categories: string[];
  history_coverage_days_min: number;
  independent_sources_min: number;
  cache_ttl_hours: number;
}

// ── 不可信输入的清洗 ───────────────────────────────────────────────────────

/** HTML 转义。代币名字里塞 `<a href=...>` 不能变成卡片上的可点链接。 */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.)/i;

/**
 * URL 校验：只允许 http(s)，阻断本机/内网地址。
 * 采集侧还必须限制响应大小、超时，并阻断重定向到内网（见 §9.1）。
 */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (PRIVATE_HOST.test(u.hostname)) return null;
  return u.toString();
}

// ── schema 校验 ────────────────────────────────────────────────────────────

const STATUSES: NarrativeStatus[] = ['pass', 'watch', 'reject', 'unknown'];
const BINDINGS: CaBinding[] = ['verified', 'unverified', 'conflict'];
const NOVELTIES: Novelty[] = ['new_in_index', 'repeated', 'insufficient_history'];
const RESONANCES: Resonance[] = ['supported', 'weak', 'unknown'];
const CATEGORIES = ['technology', 'science', 'stock_related', 'meme', 'other', 'unknown'];

/**
 * 校验一份报告。**模型返回的 JSON 必须过这一关才算数**——
 * 字段缺失、来源 URL 不合法、时间倒挂都直接拒绝，而不是「大概能用」。
 */
export function validateReport(raw: unknown): { errors: string[]; report?: NarrativeReport } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { errors: ['报告必须是对象'] };
  const r = raw as any;
  const str = (k: string, required = true) => {
    if (typeof r[k] !== 'string' || (required && !r[k])) errors.push(`${k} 必须是非空字符串`);
  };
  const num = (k: string) => { if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) errors.push(`${k} 必须是数字`); };

  str('reportId'); str('ca'); str('summary'); str('category');
  num('chainId'); num('analyzedAt'); num('availableAt');
  if (!STATUSES.includes(r.status)) errors.push(`status 必须是 ${STATUSES.join('/')}`);
  if (!BINDINGS.includes(r.caBinding)) errors.push(`caBinding 必须是 ${BINDINGS.join('/')}`);
  if (!NOVELTIES.includes(r.novelty)) errors.push(`novelty 必须是 ${NOVELTIES.join('/')}`);
  if (!RESONANCES.includes(r.marketResonance)) errors.push(`marketResonance 必须是 ${RESONANCES.join('/')}`);
  if (!CATEGORIES.includes(r.category)) errors.push(`category 必须是 ${CATEGORIES.join('/')}`);
  if (r.reviewer !== 'human' && r.reviewer !== 'model') errors.push('reviewer 必须是 human 或 model');
  if (typeof r.availableAt === 'number' && typeof r.analyzedAt === 'number' && r.availableAt < r.analyzedAt) {
    errors.push('availableAt 不能早于 analyzedAt——结论不可能比分析更早可用');
  }
  if (!Array.isArray(r.claims)) errors.push('claims 必须是数组');
  else r.claims.forEach((c: any, i: number) => {
    if (typeof c?.statement !== 'string' || !c.statement) errors.push(`claims[${i}].statement 必须是非空字符串`);
    if (typeof c?.fetchedAt !== 'number') errors.push(`claims[${i}].fetchedAt 必须是数字`);
    if (c?.url != null && !safeUrl(c.url)) errors.push(`claims[${i}].url 不是允许的 http(s) 外部地址`);
    if (typeof c?.independent !== 'boolean') errors.push(`claims[${i}].independent 必须显式声明`);
    if (typeof c?.verified !== 'boolean') errors.push(`claims[${i}].verified 必须显式声明`);
    if (c?.publishedAt != null && typeof c.publishedAt !== 'number') errors.push(`claims[${i}].publishedAt 必须是数字或 null`);
  });
  if (!Array.isArray(r.previousSameChainExamples)) errors.push('previousSameChainExamples 必须是数组（可以为空）');
  if (!Array.isArray(r.reasonCodes)) errors.push('reasonCodes 必须是数组');
  if (errors.length) return { errors };

  return {
    errors: [],
    report: {
      reportId: r.reportId, chainId: r.chainId, ca: String(r.ca).toLowerCase(),
      version: Number(r.version ?? 1), analyzedAt: r.analyzedAt, availableAt: r.availableAt,
      validUntil: r.validUntil ?? null,
      status: r.status, category: r.category, summary: r.summary,
      caBinding: r.caBinding, novelty: r.novelty, marketResonance: r.marketResonance,
      previousSameChainExamples: r.previousSameChainExamples,
      claims: r.claims.map((c: any) => ({ ...c, url: safeUrl(c.url) })),
      modelId: r.modelId ?? null, promptVersion: r.promptVersion ?? null,
      inputHash: r.inputHash ?? null, corpusVersion: r.corpusVersion ?? null,
      confidenceLabel: r.confidenceLabel ?? null,
      reviewer: r.reviewer, reasonCodes: r.reasonCodes,
    },
  };
}

// ── 判定 ───────────────────────────────────────────────────────────────────

export interface NarrativeDecision {
  status: NarrativeStatus;
  evaluations: Evaluation[];
  /** 二段标准 READY 是否放行。repeated 题材不发标准 READY。 */
  allowsStandardSignal: boolean;
  /** B/C 是否只能发「重复题材·仅观察」卡。 */
  speculativeOnly: boolean;
}

/**
 * 程序侧的最终判定。模型给的 `status` **只是候选**——
 * 这里按 §9.1 的四条硬要求重新算一遍，冲突时以程序结论为准。
 */
export function decideNarrative(report: NarrativeReport | null, cfg: NarrativeGateConfig, asOf: number): NarrativeDecision {
  const evaluations: Evaluation[] = [];
  if (!report) {
    evaluations.push(unk('narrative.report', null, 'pass',
      '还没有叙事报告（资料不足 / provider 未就绪）。形态先暂存，默认不发 TG', asOf));
    return { status: 'unknown', evaluations, allowsStandardSignal: false, speculativeOnly: false };
  }
  if (report.availableAt > asOf) {
    evaluations.push(unk('narrative.availability', report.availableAt, asOf,
      '报告在该时点还不可用，回放不能提前拿到后来补齐的资料', asOf));
    return { status: 'unknown', evaluations, allowsStandardSignal: false, speculativeOnly: false };
  }
  if (report.validUntil !== null && report.validUntil < asOf) {
    evaluations.push(unk('narrative.ttl', report.validUntil, asOf,
      `报告已过期（TTL ${cfg.cache_ttl_hours}h），后台刷新前不能凭缓存时间改写成新证据`, asOf));
    return { status: 'unknown', evaluations, allowsStandardSignal: false, speculativeOnly: false };
  }

  // 1. CA 绑定：仅同名、同 ticker 不够
  if (report.caBinding === 'conflict') {
    evaluations.push(fail('narrative.ca_binding', report.caBinding, 'verified',
      '来源之间对 CA 归属有冲突，任何总分都不能抵消这一条', asOf));
    return { status: 'reject', evaluations, allowsStandardSignal: false, speculativeOnly: false };
  }
  if (report.caBinding !== 'verified') {
    evaluations.push(unk('narrative.ca_binding', report.caBinding, 'verified',
      '没有「项目公开页面/已核验公开账号明确列出该 CA」的证据；仅同名同 ticker 不够', asOf));
    return { status: 'unknown', evaluations, allowsStandardSignal: false, speculativeOnly: false };
  }
  evaluations.push(pass('narrative.ca_binding', 'verified', 'verified', 'CA 与所分析项目有公开绑定证据', asOf));

  // 2. 题材类别与可解释性
  const categoryOk = cfg.allowed_categories.includes(report.category);
  evaluations.push(categoryOk
    ? pass('narrative.category', report.category, cfg.allowed_categories, `题材类别 ${report.category}`, asOf)
    : fail('narrative.category', report.category, cfg.allowed_categories,
        `类别 ${report.category} 不在首版偏好内（科技/科学/股票关联）；复杂不等于好，蹭股票名的克隆不自动通过`, asOf));
  if (!report.summary.trim()) {
    evaluations.push(fail('narrative.summary', '', 'non-empty', '没有能用普通中文解释清楚的概念说明', asOf));
  }

  // 3. 同链历史重复
  let speculativeOnly = false;
  if (report.novelty === 'repeated') {
    speculativeOnly = true;
    evaluations.push(fail('narrative.novelty', 'repeated', 'new_in_index',
      `本地覆盖范围内已见过同一概念（${report.previousSameChainExamples.map(e => e.concept).join('、') || '见证据'}），` +
      '二段不发标准 READY；新币分支最多发「重复题材·仅观察」卡', asOf));
  } else if (report.novelty === 'insufficient_history') {
    evaluations.push(unk('narrative.novelty', 'insufficient_history', 'new_in_index',
      `同链题材索引覆盖不足 ${cfg.history_coverage_days_min} 天，空库不能把所有项目判「从未出现」`, asOf));
  } else {
    evaluations.push(pass('narrative.novelty', 'new_in_index', 'new_in_index',
      '本地覆盖范围内未见重复（措辞只能到这个程度，不能说「全网首创」）', asOf));
  }

  // 4. 市场共鸣：至少两个可辨识的独立来源，或人工复核明确记录理由
  const independent = report.claims.filter(c => c.independent && c.verified).length;
  const humanReviewed = report.reviewer === 'human' && report.reasonCodes.length > 0;
  const resonanceOk = report.marketResonance === 'supported'
    && (independent >= cfg.independent_sources_min || humanReviewed);
  evaluations.push(resonanceOk
    ? pass('narrative.resonance', { independent, humanReviewed }, cfg.independent_sources_min,
        `${independent} 条独立来源讨论该具体概念${humanReviewed ? '（含人工复核）' : ''}`, asOf)
    : report.marketResonance === 'unknown'
      ? unk('narrative.resonance', { independent, resonance: report.marketResonance }, cfg.independent_sources_min,
          '资料不足，无法判断市场共鸣', asOf)
      : fail('narrative.resonance', { independent, resonance: report.marketResonance }, cfg.independent_sources_min,
          `独立来源只有 ${independent} 条（排除复制文案、项目自述和纯喊单后），共鸣偏弱`, asOf));

  const anyFail = evaluations.some(e => e.result === 'fail');
  const anyUnknown = evaluations.some(e => e.result === 'unknown');
  const status: NarrativeStatus = anyFail ? 'watch' : anyUnknown ? 'unknown' : 'pass';
  return {
    status,
    evaluations,
    allowsStandardSignal: status === 'pass',
    speculativeOnly,
  };
}

// ── 持久化 ─────────────────────────────────────────────────────────────────

const upsert = db.prepare(
  `INSERT INTO post_narratives (report_id, chain_id, ca, version, analyzed_at, available_at, valid_until,
     status, category, summary, ca_binding, novelty, market_resonance, claims, previous_same_chain,
     reason_codes, reviewer, model_id, prompt_version, input_hash, corpus_version, confidence_label)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(report_id) DO UPDATE SET
     status=excluded.status, category=excluded.category, summary=excluded.summary,
     ca_binding=excluded.ca_binding, novelty=excluded.novelty, market_resonance=excluded.market_resonance,
     claims=excluded.claims, previous_same_chain=excluded.previous_same_chain,
     reason_codes=excluded.reason_codes, valid_until=excluded.valid_until`,
);

export function saveReport(r: NarrativeReport): void {
  upsert.run(r.reportId, r.chainId, r.ca, r.version, r.analyzedAt, r.availableAt, r.validUntil,
    r.status, r.category, r.summary, r.caBinding, r.novelty, r.marketResonance,
    JSON.stringify(r.claims), JSON.stringify(r.previousSameChainExamples), JSON.stringify(r.reasonCodes),
    r.reviewer, r.modelId, r.promptVersion, r.inputHash, r.corpusVersion, r.confidenceLabel);
}

/** 取该时点**当时已可用**的最新报告。回放靠这一条保证不前视。 */
export function latestReport(chainId: number, ca: string, asOf: number): NarrativeReport | null {
  const r = db.prepare(
    `SELECT * FROM post_narratives WHERE chain_id=? AND ca=? AND available_at <= ? AND superseded_by IS NULL
     ORDER BY available_at DESC, version DESC LIMIT 1`,
  ).get(chainId, ca.toLowerCase(), asOf) as any;
  if (!r) return null;
  return {
    reportId: r.report_id, chainId: r.chain_id, ca: r.ca, version: r.version,
    analyzedAt: r.analyzed_at, availableAt: r.available_at, validUntil: r.valid_until,
    status: r.status, category: r.category, summary: r.summary,
    caBinding: r.ca_binding, novelty: r.novelty, marketResonance: r.market_resonance,
    previousSameChainExamples: JSON.parse(r.previous_same_chain ?? '[]'),
    claims: JSON.parse(r.claims ?? '[]'),
    modelId: r.model_id, promptVersion: r.prompt_version, inputHash: r.input_hash,
    corpusVersion: r.corpus_version, confidenceLabel: r.confidence_label,
    reviewer: r.reviewer, reasonCodes: JSON.parse(r.reason_codes ?? '[]'),
  };
}

/** 复核推翻旧结论：标 superseded，不静默替换历史结论（§9.1）。 */
export function supersedeReport(oldReportId: string, newReportId: string): void {
  db.prepare('UPDATE post_narratives SET superseded_by=? WHERE report_id=?').run(newReportId, oldReportId);
}

export const reportIdFor = (chainId: number, ca: string, analyzedAt: number, reviewer: string): string =>
  `N-${chainId}-${createHash('sha256').update(`${ca.toLowerCase()}|${analyzedAt}|${reviewer}`).digest('hex').slice(0, 12)}`;

// ── 同链题材库（§9.2） ─────────────────────────────────────────────────────

export interface Topic {
  topicId: string; chainId: number; category: string; concept: string;
  eventKey: string | null; firstObservedAt: number; sourcePublishedAt: number | null;
  availableAt: number; coverageNote: string; evidence: string | null;
}

export function recordTopic(t: Topic): void {
  db.prepare(
    `INSERT INTO post_topics (topic_id, chain_id, category, concept, event_key, first_observed_at,
       source_published_at, available_at, coverage_note, evidence)
     VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(topic_id) DO NOTHING`,
  ).run(t.topicId, t.chainId, t.category, t.concept, t.eventKey, t.firstObservedAt,
    t.sourcePublishedAt, t.availableAt, t.coverageNote, t.evidence);
}

export function linkTopic(topicId: string, chainId: number, ca: string, linkedAt: number,
                          similarityReason: string, evidence: string | null, outcome: string | null = null): void {
  db.prepare(
    `INSERT INTO post_topic_links (topic_id, chain_id, ca, linked_at, similarity_reason, evidence, outcome)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(topic_id, chain_id, ca) DO UPDATE SET outcome=excluded.outcome`,
  ).run(topicId, chainId, ca.toLowerCase(), linkedAt, similarityReason, evidence, outcome);
}

/**
 * 同链是否出现过同一**具体概念**。用规范化概念实体匹配，
 * 不能只用宽泛的「AI」把所有项目判成重复（§9.2）。
 * 只看 availableAt ≤ asOf 的记录，历史回测不能用后来才入库的题材证据。
 */
export function findRepeatedTopics(chainId: number, concept: string, asOf: number, excludeCa?: string):
  { topicId: string; concept: string; firstObservedAt: number; cas: string[] }[] {
  const key = normalizeConcept(concept);
  const rows = db.prepare(
    `SELECT topic_id, concept, first_observed_at FROM post_topics
     WHERE chain_id=? AND available_at <= ? ORDER BY first_observed_at`,
  ).all(chainId, asOf) as any[];
  return rows
    .filter(r => normalizeConcept(r.concept) === key)
    .map(r => {
      const cas = (db.prepare('SELECT ca FROM post_topic_links WHERE topic_id=? AND linked_at <= ?')
        .all(r.topic_id, asOf) as any[]).map(x => x.ca).filter(ca => ca !== excludeCa?.toLowerCase());
      return { topicId: r.topic_id, concept: r.concept, firstObservedAt: r.first_observed_at, cas };
    })
    .filter(t => t.cas.length > 0);
}

/** 概念规范化：去空白、统一小写。仍然是具体实体，不做同义词归并。 */
export const normalizeConcept = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** 索引覆盖天数——空库时不能把所有项目判「从未出现」。 */
export function topicCoverageDays(chainId: number, asOf: number): number {
  const r = db.prepare('SELECT MIN(available_at) t FROM post_topics WHERE chain_id=? AND available_at <= ?')
    .get(chainId, asOf) as any;
  return r?.t ? (asOf - r.t) / 86_400_000 : 0;
}
