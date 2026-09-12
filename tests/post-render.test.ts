import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderSecondLeg, renderNewPullback, renderRiskCard, renderFollowUp, clamp, linkButtons,
  MAX_CARD_CHARS, type CardContext, type SecondLegCardInput,
} from '../src/notify/post-render.js';

const ctx: CardContext = { timezone: 'Asia/Hong_Kong', locale: 'zh' };
const NOW = 1_800_000_000_000;
const CA = '0x1234567890abcdef1234567890abcdef12345678';

const base = (over: Partial<SecondLegCardInput> = {}): SecondLegCardInput => ({
  symbol: 'SAMPLE', ca: CA, priceUsd: 0.0041, fdvUsd: 4.1e6,
  boxLower: 0.0034, boxUpper: 0.0047, rangeAgeHours: 57.5,
  firstLegMultiple: 2.8, maxDrawdown: 0.54, insideRatio: 0.86, zoneVisits: 4,
  timeframeLabel: '15m', sizeBandLabel: '3–5M 口径：FDV 代理（暂定）',
  narrativeSummary: '某具体科技事件的 meme 延伸', narrativeNovelty: '本地历史范围内未见重复',
  narrativeClaims: 2, invalidBelow: 0.003128, expiresAt: NOW + 38 * 3600_000,
  rsi: 64, rsiTimeframe: '15m', dataQuality: '完整', quoteNote: 'USDG 按 $1 代理',
  source: 'chain', signalId: 'SL-abc123', configHash: '97829798', marketAsOf: NOW,
  ...over,
});

test('二段主卡包含必要字段：链/CA/类别/周期/关键数值/叙事/失效条件/数据质量/signalId', () => {
  const t = renderSecondLeg(base(), ctx);
  for (const must of ['二段观察就绪', CA, '15m', 'FDV（市值代理）', '箱体', '已横盘',
    '第一波', '箱内收盘', '区域往返', '3–5M 口径', '叙事', '观察失效', '箱体截止',
    'RSI(9,15m)', '数据：', 'SL-abc123', 'config 97829798']) {
    assert.ok(t.includes(must), `卡片缺少「${must}」:\n${t}`);
  }
  assert.match(t, /不是买入成交指令/);
});

test('不堆旧 FOMO 指标', () => {
  const t = renderSecondLeg(base(), ctx);
  for (const forbidden of ['持币人数', 'FOMO 占比', '盈利榜', 'Top10', '全链 ']) {
    assert.ok(!t.includes(forbidden), `卡片不该出现「${forbidden}」`);
  }
});

test('代币名字里的 HTML 被转义，不能注入链接', () => {
  const t = renderSecondLeg(base({ symbol: '<a href="https://evil.example">CLICK</a>' }), ctx);
  assert.ok(!t.includes('<a href='), '不能出现可点链接');
  assert.ok(t.includes('&lt;a href='));
});

test('外链按钮只放行校验过的 URL；恶意证据链接被丢掉', () => {
  const ok = linkButtons(CA, 'https://example.org/evidence') as any;
  assert.equal(ok.inline_keyboard[0].length, 3);
  const bad = linkButtons(CA, 'javascript:alert(1)') as any;
  assert.equal(bad.inline_keyboard[0].length, 2, '非法 URL 不进卡片');
});

test('没有供应量时 FDV 显示「未知」，不拿别的数凑', () => {
  assert.match(renderSecondLeg(base({ fdvUsd: null }), ctx), /FDV（市值代理）未知/);
});

test('影线跌破箱底必须显示风险，不能只报 close', () => {
  assert.match(renderSecondLeg(base({ wickRisk: true }), ctx), /影线跌破箱底/);
});

test('失效后的卡片标失效并保留原因，不撤掉失败样本', () => {
  const t = renderSecondLeg(base({ invalidated: { at: NOW, reason: '连续 3 根收盘跌破箱底' } }), ctx);
  assert.match(t, /二段观察已失效/);
  assert.match(t, /连续 3 根收盘跌破箱底/);
});

test('新币卡片列出两轮细节与失效参考价，并注明非保证成交价', () => {
  const t = renderNewPullback({
    symbol: 'SAMPLE', ca: CA, ageLabel: '2h14m', timeframeLabel: '1m',
    cycle1: { dip: 0.23, recovered: 0.71 }, cycle2: { dip: 0.19, recovered: 0.66 },
    d1: 0.0012, d2: 0.0011, distanceFromSecondLow: 0.18, millionReclaim: true,
    narrativeSummary: '科技概念', narrativeNovelty: '本地新题材', speculativeOnly: false,
    invalidBelow: 0.001045, confirmedAt: NOW, sentAt: NOW + 8000,
    signalId: 'NP-1', configHash: 'cfg', dataQuality: '完整',
  }, ctx);
  assert.match(t, /第一次：回撤 23% → 收复跌幅 71%/);
  assert.match(t, /第二次：回撤 19% → 收复跌幅 66%/);
  assert.match(t, /同时命中：1–2M 关口回踩后创新高/);
  assert.match(t, /非保证成交价/);
});

test('重复题材只能发「仅观察」卡，不带标准确认标签', () => {
  const t = renderNewPullback({
    symbol: 'S', ca: CA, ageLabel: '1h', timeframeLabel: '1m',
    cycle1: { dip: 0.2, recovered: 0.7 }, cycle2: { dip: 0.15, recovered: 0.7 },
    d1: 1, d2: 1, distanceFromSecondLow: 0.1, millionReclaim: false,
    narrativeSummary: '旧题材', narrativeNovelty: '本地已见过同一概念', speculativeOnly: true,
    invalidBelow: 0.95, confirmedAt: NOW, sentAt: NOW, signalId: 'NP-2', configHash: 'c', dataQuality: '完整',
  }, ctx);
  assert.match(t, /重复题材 · 仅观察/);
  assert.ok(!t.includes('新币两次回拉确认'));
});

test('没有人工成本时只写「相对首次信号价」，绝不写成收益', () => {
  const t = renderRiskCard({
    symbol: 'S', ca: CA, relatedSignalId: 'NP-1', rsi: 92.1, rsiTimeframe: '1m', rsiLength: 9,
    firstObservation: false, changeFromFirstSignal: 0.37, referenceEntry: null,
    exitFraction: 0.25, marketAsOf: NOW,
  }, ctx);
  assert.match(t, /相对首次信号价 \+37%（非实际持仓收益）/);
  assert.ok(!t.includes('已止盈'));
  assert.ok(!t.includes('盈利'));
  assert.match(t, /不代表已见顶/);
  assert.match(t, /80\/20 只是参考线/);
});

test('有人工参考价时标明是价格变化而不是净收益', () => {
  const t = renderRiskCard({
    symbol: 'S', ca: CA, relatedSignalId: 'NP-1', rsi: 91, rsiTimeframe: '1m', rsiLength: 9,
    firstObservation: true, changeFromFirstSignal: null,
    referenceEntry: { priceUsd: 0.001, changePct: 0.5 }, exitFraction: 0.25, marketAsOf: NOW,
  }, ctx);
  assert.match(t, /价格变化，非净收益/);
  assert.match(t, /开始跟踪时已在 ≥90 区间（不是刚上穿）/);
});

test('25% 说明成四等份，且不维护「已卖出」状态', () => {
  const t = renderRiskCard({
    symbol: 'S', ca: CA, relatedSignalId: 'X', rsi: 95, rsiTimeframe: '1m', rsiLength: 9,
    firstObservation: false, changeFromFirstSignal: null, referenceEntry: null,
    exitFraction: 0.25, marketAsOf: NOW,
  }, ctx);
  assert.match(t, /四等份合计 100%/);
  assert.match(t, /不维护「已卖出」状态/);
});

test('关联简讯带原 signalId', () => {
  const t = renderFollowUp({
    symbol: 'S', ca: CA, relatedSignalId: 'SL-abc', headline: '⚪️ 二段观察已失效',
    reason: '连续 3 根收盘跌破箱底', at: NOW,
  }, ctx);
  assert.match(t, /SL-abc/);
});

test('超长卡片按优先级裁剪，CA 与关键条件保留', () => {
  const long = base({ narrativeSummary: '证'.repeat(200) });
  const padded = renderSecondLeg(long, ctx) + '\n' + Array(800).fill('额外证据摘要行').join('\n');
  const out = clamp(padded, CA);
  assert.ok(out.length <= MAX_CARD_CHARS);
  assert.ok(out.includes(CA), 'CA 必须保留');
  assert.ok(out.includes('观察失效'), '失效条件必须保留');
  assert.match(out, /已裁剪 \d+ 行证据摘要/);
});

test('正常卡片远低于 Telegram 4096 上限', () => {
  assert.ok(renderSecondLeg(base(), ctx).length < 1500);
});

test('时间按配置时区渲染', () => {
  const t = renderSecondLeg(base(), ctx);
  assert.match(t, /箱体截止：\d{2}\/\d{2} \d{2}:\d{2}/);
  assert.match(t, /GMT\+8|UTC\+8/);
});
