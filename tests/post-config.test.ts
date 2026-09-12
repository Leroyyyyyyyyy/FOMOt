import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validatePostConfig, configHash, loadPostConfigFile, POST_CONFIG_PATH } from '../src/post/config.js';

const base = () => parse(readFileSync(POST_CONFIG_PATH, 'utf8')) as any;
const errorsOf = (mutate: (c: any) => void) => {
  const c = base();
  mutate(c);
  return validatePostConfig(c).errors;
};
const hasError = (errs: string[], needle: string) =>
  errs.some(e => e.includes(needle)) || assert.fail(`期望有含「${needle}」的错误，实际:\n${errs.join('\n') || '(无错误)'}`);

test('仓库自带的 config/post-strategy.yaml 必须能通过校验', () => {
  const r = loadPostConfigFile();
  assert.deepEqual(r.errors, []);
  assert.ok(r.config, '必须解析出配置');
  assert.match(r.hash!, /^[0-9a-f]{8}$/);
});

test('未知 key 一律报错，不静默忽略', () => {
  hasError(errorsOf(c => { c.second_leg.box_with_max = 0.6; }), '未知配置项 second_leg.box_with_max');
  hasError(errorsOf(c => { c.extra_section = {}; }), '未知配置项 extra_section');
});

test('缺字段报错，不落回默认值', () => {
  hasError(errorsOf(c => { delete c.rsi.overheat; }), 'rsi.overheat 缺失');
});

test('比例字段超出 0–1 被拒', () => {
  hasError(errorsOf(c => { c.second_leg.first_pullback_min = 1.5; }), 'second_leg.first_pullback_min 不能大于 1');
  hasError(errorsOf(c => { c.market.real_bar_ratio_min = -0.1; }), 'market.real_bar_ratio_min 不能小于 0');
});

test('整数字段不接受小数', () => {
  hasError(errorsOf(c => { c.second_leg.breakout_confirm_bars = 1.5; }), 'second_leg.breakout_confirm_bars 必须是整数');
});

test('48–96h 的先后关系与建箱窗口必须成立', () => {
  hasError(errorsOf(c => { c.second_leg.ready_min_hours = 100; }), 'ready_min_hours 必须小于 ready_max_hours');
  hasError(errorsOf(c => { c.second_leg.seed_box_hours = 60; }), 'seed_box_hours 必须小于 ready_min_hours');
});

test('mode=volume_usd 必须显式给窗口；其它模式不许给', () => {
  hasError(errorsOf(c => { c.size_band.mode = 'volume_usd'; }), 'volume_window_hours 必须是正数');
  assert.deepEqual(errorsOf(c => { c.size_band.mode = 'volume_usd'; c.size_band.volume_window_hours = 24; }), []);
  hasError(errorsOf(c => { c.size_band.volume_window_hours = 24; }), '只在 mode=volume_usd 时有意义');
});

test('mode=off 合法：用于比较策略对 3–5M 歧义的敏感性', () => {
  assert.deepEqual(errorsOf(c => { c.size_band.mode = 'off'; }), []);
});

test('collapse_drawdown 必须与版本化常量 close≤H×0.2 互补', () => {
  hasError(errorsOf(c => { c.second_leg.collapse_drawdown = 0.75; }), 'firstLegCollapseCloseRatio');
});

test('第一波回撤门不能大于等于归零门', () => {
  hasError(errorsOf(c => { c.second_leg.first_pullback_min = 0.85; }),
    'first_pullback_min 必须小于 collapse_drawdown');
});

test('RSI 参考线与过热阈值的顺序约束', () => {
  hasError(errorsOf(c => { c.rsi.reference_lower = 90; }), 'reference_upper 必须大于 reference_lower');
  hasError(errorsOf(c => { c.rsi.overheat = 70; }), 'overheat 不能低于 reference_upper');
  hasError(errorsOf(c => { c.rsi.rearm_below_or_equal = 95; }), 'rearm_below_or_equal 必须小于 overheat');
  hasError(errorsOf(c => { c.rsi.recommended_warmup_bars = 5; }), 'recommended_warmup_bars 至少要有 length+1 根');
});

test('保留窗口必须覆盖策略需要的历史，否则自己把箱体裁掉', () => {
  hasError(errorsOf(c => { c.history.candle_higher_retention_days = 2; }),
    'candle_higher_retention_days 必须覆盖 second_leg.ready_max_hours');
  hasError(errorsOf(c => { c.history.candle_1m_retention_days = 1; c.new_pullback.max_age_hours = 48; }),
    'candle_1m_retention_days 必须覆盖 new_pullback.max_age_hours');
  hasError(errorsOf(c => { c.history.evidence_retention_days = 10; }),
    'evidence_retention_days 不能短于 K 线保留');
});

test('两轮回拉的总时限必须容得下两个单轮上限', () => {
  hasError(errorsOf(c => { c.new_pullback.total_max_minutes = 40; }),
    'total_max_minutes 至少要能容纳两个 cycle_max_minutes');
});

test('关掉叙事硬门必须同时把 version 标成 experimental', () => {
  hasError(errorsOf(c => { c.narrative.required_for_standard_signal = false; }), 'version 必须包含 experimental');
  assert.deepEqual(errorsOf(c => {
    c.narrative.required_for_standard_signal = false;
    c.version = 'post_v1_experimental';
  }), []);
});

test('backfill 启动模式必须有正的 lookback', () => {
  hasError(errorsOf(c => { c.history.startup_mode = 'backfill'; c.history.lookback_days = 0; }),
    'lookback_days 必须为正');
});

test('时区必须是有效 IANA 名字', () => {
  hasError(errorsOf(c => { c.render.timezone = 'Mars/Olympus'; }), 'render.timezone 不是有效时区');
});

test('configHash 与 key 顺序无关，但阈值一变就变', () => {
  const a = base();
  const reordered = Object.fromEntries(Object.keys(a).reverse().map(k => [k, a[k]]));
  assert.equal(configHash(a), configHash(reordered), 'key 顺序不应影响指纹');
  const b = base();
  b.second_leg.breakout_buffer = 0.05;
  assert.notEqual(configHash(a), configHash(b), '阈值改了指纹必须变');
});
