import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialGate, recheckGate, fomoGate } from '../src/engine/rules.js';
import { emptyEnriched, enrichSocial } from '../src/engine/enrich.js';
import { snapshot, statsFromPnls, leader } from './helpers/fixtures.js';
import type { Rules } from '../src/config.js';

type Filters = Rules['filters'];
const filters = (over: Partial<Filters> = {}): Filters => ({
  market_cap_usd: {}, volume_5m_usd: {}, volume_1h_usd: {}, holders_total: {},
  fomo_holders: { min: 0 }, fomo_holder_ratio: { min: 0 }, fomo_leaderboard_holders: { min: 0 },
  skip_when_unavailable: true, fomo_gate_stage: 'recheck', ...over,
});

const full = () => enrichSocial(18, snapshot(), statsFromPnls(Array(10).fill(1)), [leader()], true);

test('刷新失败 + skip_when_unavailable=true：是 missing，不是 pass', () => {
  // 这正是旧代码的错误——空 enrichment 被规则「放行」，随后任务被标成 completed。
  const g = recheckGate(200, emptyEnriched(), filters({ skip_when_unavailable: true }));
  assert.equal(g.kind, 'missing', '数据没采到不等于规则通过');
  assert.notEqual(g.kind, 'pass');
});

test('刷新失败 + skip_when_unavailable=false：是 reject', () => {
  const g = recheckGate(200, emptyEnriched(), filters({ skip_when_unavailable: false }));
  assert.equal(g.kind, 'reject');
});

test('复核拿不到持币快照是 missing，不能据此撤回', () => {
  const g = recheckGate(null, full(), filters());
  assert.equal(g.kind, 'missing');
});

test('数据齐全且满足阈值才是 pass', () => {
  const g = recheckGate(200, full(), filters());
  assert.equal(g.kind, 'pass');
});

test('数据齐全但不满足阈值是 reject（该撤就撤）', () => {
  const g = recheckGate(200, full(), filters({ fomo_holders: { min: 999 } }));
  assert.equal(g.kind, 'reject');
  assert.match((g as any).reason, /Fomo 持币人/);
});

test('榜单不可用在宽松模式下是 missing 而不是 pass', () => {
  const e = enrichSocial(18, snapshot(), statsFromPnls(Array(10).fill(1)), [], false);
  const g = fomoGate(200, e, filters({ skip_when_unavailable: true }));
  assert.equal(g.kind, 'missing');
});

test('fomo_gate_stage=off 时复核不因 FOMO 缺数据而卡住', () => {
  const g = recheckGate(200, emptyEnriched(), filters({ fomo_gate_stage: 'off' }));
  assert.equal(g.kind, 'pass');
});

test('初值阶段：持币快照缺失是 missing，人数不达标是 reject', () => {
  assert.equal(initialGate(null, full(), filters()).kind, 'missing');
  assert.equal(initialGate(5, full(), filters({ holders_total: { min: 100 } })).kind, 'reject');
  assert.equal(initialGate(500, full(), filters({ holders_total: { min: 100 } })).kind, 'pass');
});

test('初值阶段默认不拿 FOMO 当门（fomo_gate_stage=recheck）', () => {
  const g = initialGate(500, emptyEnriched(), filters({ fomo_gate_stage: 'recheck' }));
  assert.equal(g.kind, 'pass', 'FOMO 索引对新币有延迟，初值不该因此被误杀');
});

// ── 重试期限 ─────────────────────────────────────────────────────────

test('复核异常也要受重试期限约束，不能永远重试下去', () => {
  // 回归：catch 分支里原本有 continue，会跳过期限检查，
  // 于是一个持续抛异常的复核任务会无限重试，永远不终结。
  const src = readFileSync(new URL('../src/engine/index.ts', import.meta.url), 'utf8');
  const loop = src.slice(src.indexOf('let outcome:'), src.indexOf('RECHECK_DEADLINE_MS) {'));
  assert.ok(!/\bcontinue;/.test(loop),
    'catch 分支不能 continue，否则会跳过 originalDueTs + RECHECK_DEADLINE_MS 的期限检查');
  assert.match(loop, /outcome === 'done'/);
});

test('重试只改下次时间，不覆盖原定到期时间', () => {
  const src = readFileSync(new URL('../src/engine/index.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('private scheduleRetry'), src.indexOf('private async enrich'));
  assert.match(fn, /state\.recheckDueTs = Date\.now\(\) \+ RECHECK_RETRY_MS/);
  assert.ok(!/originalDueTs\s*=/.test(fn), 'originalDueTs 不能被重试改写');
});

test('全平台 24H 收益完全不在持币采集路径上', () => {
  // 回归：它曾经开在初值路径上，把初值从 1.7s 拖到 1m11s（十次浏览器导航约 71 秒）；
  // 后来挪到复核里，又把复核从 +5m1s 拖到 +5m56s。现在它两条路径都不占——
  // 预取在到期前跑，没就绪就先出卡再原地补。
  const src = readFileSync(new URL('../src/engine/index.ts', import.meta.url), 'utf8');
  const enrich = src.slice(src.indexOf('private async enrich('), src.indexOf('private sourceInfo'));
  assert.ok(!/platformPnl24h/.test(enrich), 'enrich 里不得出现任何取全平台收益的调用');
  const stage = src.slice(src.indexOf('private async collectStage'), src.indexOf('private recordAges'));
  assert.ok(!/platformPnl24h/.test(stage), '持币采集阶段不得等待全平台收益');
});
