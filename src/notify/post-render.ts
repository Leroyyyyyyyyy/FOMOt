/**
 * post 模式的中文卡片（设计文档 §11.2）。
 *
 * 硬约束：
 *   - HTML 只转义 `& < >`，URL 单独校验；**代币名字不能注入链接**。
 *   - 主卡精简到约 3500 字符预留空间；Telegram 的上限是实体解析后 1–4096 字符。
 *     超长时按优先级裁掉证据摘要，CA 与关键条件必须保留。
 *   - 不堆旧 FOMO 指标（持币人数、FOMO 占比、Top10 PnL 一律不出现）。
 *   - 没有用户持仓成本时，只显示「相对首次信号价」的变化，绝不写成收益。
 */
import { chain, links } from '../config.js';
import { escapeHtml, safeUrl } from '../post/narrative.js';

/** 主卡软上限。Telegram 硬上限 4096（实体解析后），这里留出余量。 */
export const MAX_CARD_CHARS = 3500;

export interface CardContext {
  timezone: string;
  locale: string;
}

export interface SecondLegCardInput {
  symbol: string | null;
  ca: string;
  priceUsd: number;
  fdvUsd: number | null;
  boxLower: number; boxUpper: number;
  rangeAgeHours: number;
  firstLegMultiple: number;
  maxDrawdown: number;
  insideRatio: number;
  zoneVisits: number;
  timeframeLabel: string;
  sizeBandLabel: string;
  narrativeSummary: string | null;
  narrativeNovelty: string;
  narrativeClaims: number;
  invalidBelow: number;
  expiresAt: number;
  rsi: number | null;
  rsiTimeframe: string;
  dataQuality: string;
  quoteNote: string;
  source: string;
  signalId: string;
  configHash: string;
  marketAsOf: number;
  /** 影线曾跌破箱底但收盘没有——必须显示这个风险，不能只报 close。 */
  wickRisk?: boolean;
  invalidated?: { at: number; reason: string } | null;
}

const fmtUsd = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
};
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

export function fmtTime(ts: number, ctx: CardContext): string {
  return new Intl.DateTimeFormat(ctx.locale === 'zh' ? 'zh-CN' : ctx.locale, {
    timeZone: ctx.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts));
}
const tzLabel = (ctx: CardContext) => {
  const off = new Intl.DateTimeFormat('en', { timeZone: ctx.timezone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? ctx.timezone;
  return off;
};

/** 外链按钮。URL 逐个校验，不可信来源的链接不进卡片。 */
export function linkButtons(ca: string, evidenceUrl?: string | null): unknown {
  const row = [
    { text: '行情', url: links.gmgn(ca) },
    { text: '浏览器', url: links.scout(ca) },
  ];
  const ev = safeUrl(evidenceUrl ?? null);
  if (ev) row.push({ text: '叙事证据', url: ev });
  return { inline_keyboard: [row.filter(b => safeUrl(b.url))] };
}

/** 代币标题。symbol 是链上可控字符串，必须转义。 */
const title = (symbol: string | null, ca: string) =>
  `${escapeHtml(symbol?.slice(0, 24) ?? '未知代币')} · <code>${escapeHtml(shortCa(ca))}</code>`;
const shortCa = (ca: string) => `${ca.slice(0, 6)}…${ca.slice(-4)}`;

export function renderSecondLeg(i: SecondLegCardInput, ctx: CardContext): string {
  const lines: string[] = [];
  lines.push(`${i.invalidated ? '⚪️ 二段观察已失效' : '🟡 二段观察就绪'} · ${title(i.symbol, i.ca)}`);
  lines.push(`${escapeHtml(chain.name)} · CA: <code>${escapeHtml(i.ca)}</code>`);
  lines.push(`价格 ${fmtUsd(i.priceUsd)} · FDV（市值代理）${i.fdvUsd === null ? '未知' : fmtUsd(i.fdvUsd)}`);
  lines.push(`箱体 ${fmtUsd(i.boxLower)}–${fmtUsd(i.boxUpper)} · 已横盘 ${i.rangeAgeHours.toFixed(1)}h`);
  lines.push(`第一波 ${i.firstLegMultiple.toFixed(1)}×；其后最大收盘回撤 ${pct(i.maxDrawdown)}`);
  lines.push(`箱内收盘 ${pct(i.insideRatio)} · 区域往返 ${i.zoneVisits} 次 · ${escapeHtml(i.timeframeLabel)}`);
  lines.push(escapeHtml(i.sizeBandLabel));
  if (i.wickRisk) lines.push('⚠️ 期间有影线跌破箱底（收盘未破），请注意插针风险');
  lines.push('');
  lines.push(`叙事：${i.narrativeSummary ? escapeHtml(i.narrativeSummary.slice(0, 120)) : '待核验'}`);
  lines.push(`${escapeHtml(i.narrativeNovelty)} · 证据 ${i.narrativeClaims} 条`);
  lines.push(i.invalidated
    ? `失效时间 ${fmtTime(i.invalidated.at, ctx)}（${escapeHtml(i.invalidated.reason.slice(0, 80))}）`
    : '当前条件：已收盘形态成立，尚未突破');
  lines.push(`观察失效：收盘 &lt; ${fmtUsd(i.invalidBelow)} 或持续跌破箱底`);
  lines.push(`箱体截止：${fmtTime(i.expiresAt, ctx)}（${escapeHtml(tzLabel(ctx))}）`);
  lines.push(`RSI(9,${escapeHtml(i.rsiTimeframe)}) ${i.rsi === null ? 'n/a' : i.rsi.toFixed(0)} · 行情截至 ${fmtTime(i.marketAsOf, ctx)}`);
  lines.push(`数据：${escapeHtml(i.dataQuality)}；${escapeHtml(i.quoteNote)}；来源 ${escapeHtml(i.source)}`);
  lines.push(`信号 ${escapeHtml(i.signalId)} · 规则 post_v1 / config ${escapeHtml(i.configHash)}`);
  lines.push('这是观察提示，不是买入成交指令。');
  return clamp(lines.join('\n'), i.ca);
}

export interface NewPullbackCardInput {
  symbol: string | null;
  ca: string;
  ageLabel: string;
  timeframeLabel: string;
  cycle1: { dip: number; recovered: number };
  cycle2: { dip: number; recovered: number };
  d1: number; d2: number;
  distanceFromSecondLow: number;
  millionReclaim: boolean;
  narrativeSummary: string | null;
  narrativeNovelty: string;
  speculativeOnly: boolean;
  invalidBelow: number;
  confirmedAt: number;
  sentAt: number;
  signalId: string;
  configHash: string;
  dataQuality: string;
}

export function renderNewPullback(i: NewPullbackCardInput, ctx: CardContext): string {
  const lines: string[] = [];
  lines.push(`${i.speculativeOnly ? '🔵 重复题材 · 仅观察' : '🟢 新币两次回拉确认'} · ${title(i.symbol, i.ca)}`);
  lines.push(`CA: <code>${escapeHtml(i.ca)}</code> · 币龄 ${escapeHtml(i.ageLabel)} · 周期 ${escapeHtml(i.timeframeLabel)}`);
  lines.push(`第一次：回撤 ${pct(i.cycle1.dip)} → 收复跌幅 ${pct(i.cycle1.recovered)}`);
  lines.push(`第二次：回撤 ${pct(i.cycle2.dip)} → 收复跌幅 ${pct(i.cycle2.recovered)}`);
  lines.push(`D1 ${fmtUsd(i.d1)} / D2 ${fmtUsd(i.d2)} · 当前距 D2 +${pct(i.distanceFromSecondLow)}`);
  if (i.millionReclaim) lines.push('同时命中：1–2M 关口回踩后创新高');
  lines.push(`叙事：${i.narrativeSummary ? escapeHtml(i.narrativeSummary.slice(0, 100)) : '待核验'} · ${escapeHtml(i.narrativeNovelty)}`);
  if (i.speculativeOnly) lines.push('题材在本地覆盖范围内重复出现，本卡不带标准确认标签。');
  lines.push(`失效参考：D2 × 0.95 = ${fmtUsd(i.invalidBelow)}（非保证成交价）`);
  lines.push(`数据：${escapeHtml(i.dataQuality)}`);
  lines.push(`确认 ${fmtTime(i.confirmedAt, ctx)} · 发送 ${fmtTime(i.sentAt, ctx)} · 信号 ${escapeHtml(i.signalId)}`);
  lines.push(`规则 post_v1 / config ${escapeHtml(i.configHash)}`);
  return clamp(lines.join('\n'), i.ca);
}

export interface RiskCardInput {
  symbol: string | null;
  ca: string;
  relatedSignalId: string;
  rsi: number;
  rsiTimeframe: string;
  rsiLength: number;
  firstObservation: boolean;
  changeFromFirstSignal: number | null;
  referenceEntry: { priceUsd: number; changePct: number } | null;
  exitFraction: number;
  marketAsOf: number;
}

export function renderRiskCard(i: RiskCardInput, ctx: CardContext): string {
  const lines: string[] = [];
  lines.push(`🟠 过热提醒 · ${title(i.symbol, i.ca)} · ${escapeHtml(i.relatedSignalId)}`);
  lines.push(`RSI(${i.rsiLength}, ${escapeHtml(i.rsiTimeframe)})=${i.rsi.toFixed(1)}，${i.firstObservation ? '开始跟踪时已在 ≥90 区间（不是刚上穿）' : '首次进入 ≥90 区间'}`);
  if (i.referenceEntry) {
    // 人工导入的参考价：只显示相对该价格的变化，不标净收益（不含手续费/税费/滑点）。
    lines.push(`相对人工参考价 ${fmtUsd(i.referenceEntry.priceUsd)} 变化 ${i.referenceEntry.changePct >= 0 ? '+' : ''}${(i.referenceEntry.changePct * 100).toFixed(0)}%（价格变化，非净收益）`);
  } else if (i.changeFromFirstSignal !== null) {
    lines.push(`相对首次信号价 ${i.changeFromFirstSignal >= 0 ? '+' : ''}${(i.changeFromFirstSignal * 100).toFixed(0)}%（非实际持仓收益）`);
  }
  lines.push(`如已有利润，可检查是否按原始参考仓位 ${pct(i.exitFraction)} 分批减仓（四等份合计 100%，本系统不维护「已卖出」状态）。`);
  lines.push(`行情截至 ${fmtTime(i.marketAsOf, ctx)} · 不代表已见顶；80/20 只是参考线。`);
  return clamp(lines.join('\n'), i.ca);
}

export interface FollowUpInput {
  symbol: string | null;
  ca: string;
  relatedSignalId: string;
  headline: string;
  reason: string;
  at: number;
}

/** 失效 / 突破 / 突破失败 的关联简讯。原卡另行编辑，失败样本不撤回。 */
export function renderFollowUp(i: FollowUpInput, ctx: CardContext): string {
  return clamp([
    `${escapeHtml(i.headline)} · ${title(i.symbol, i.ca)}`,
    `${escapeHtml(i.reason.slice(0, 200))}`,
    `${fmtTime(i.at, ctx)} · 关联信号 ${escapeHtml(i.relatedSignalId)}`,
  ].join('\n'), i.ca);
}

/**
 * 超长裁剪。按优先级砍掉证据摘要行，**CA 与关键条件必须保留**。
 * 真被砍到了就在末尾注明，不静默丢内容。
 */
export function clamp(text: string, ca: string, max = MAX_CARD_CHARS): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  const keep = (l: string) => /CA:|失效|箱体截止|信号 |规则 post_v1|价格 |D1 |D2 /.test(l);
  // 先给裁剪说明留出位置，否则说明本身会被最后的截断吃掉。
  const NOTE_BUDGET = 40;
  const kept: string[] = [];
  let len = 0, dropped = 0;
  for (const l of lines) {
    if (keep(l) || len + l.length + 1 <= max - NOTE_BUDGET) { kept.push(l); len += l.length + 1; }
    else dropped++;
  }
  let out = kept.join('\n');
  // 必保留的行本身就超长时，只能硬截断，但仍要留出说明的位置。
  if (out.length > max - NOTE_BUDGET) out = out.slice(0, max - NOTE_BUDGET);
  return dropped ? `${out}\n（已裁剪 ${dropped} 行证据摘要以适配长度上限）` : out;
}
