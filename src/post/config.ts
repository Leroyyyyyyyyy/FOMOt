/**
 * post_v1 配置加载与运行时校验（设计文档 §12）。
 *
 * 三条硬要求：
 *   1. **未知 key 报错**。YAML 写错一个字母就静默变成 undefined，旧 rules.yaml 吃过这个亏；
 *      这里反过来，schema 里没声明的 key 一律拒绝启动。
 *   2. **运行时校验**，不只靠 TS 类型。配置是外部输入，`as Config` 什么都保证不了。
 *   3. **不覆盖 rules.yaml**，也不让旧规则校验成为 post 模式的前置条件。
 *
 * 另外把「没写进 YAML 的固定常量」集中到 VERSIONED_DEFAULTS，避免同一个数字
 * 散落在多个模块里出现互相冲突的值（§12 末段）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

// ── schema 声明 ────────────────────────────────────────────────────────────

type Spec =
  | { t: 'num'; min?: number; max?: number; int?: boolean }
  | { t: 'bool' }
  | { t: 'str' }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'tz' }
  | { t: 'numOrNull'; min?: number; max?: number }
  | { t: 'numArr'; len?: number; min?: number; max?: number }
  | { t: 'enumArr'; values: readonly string[]; min?: number }
  | { t: 'intArr'; min?: number };

const num = (min?: number, max?: number): Spec => ({ t: 'num', min, max });
const int = (min?: number, max?: number): Spec => ({ t: 'num', min, max, int: true });
/** 0–1 的小数比例。倍率另用 num(1) 表达，两者不可混用。 */
const ratio = (): Spec => ({ t: 'num', min: 0, max: 1 });

const SCHEMA: Record<string, Record<string, Spec>> = {
  scan: {
    realtime_interval_ms: int(50),
    closed_bar_grace_seconds: num(0, 600),
    historical_concurrency: int(1, 16),
    hot_limit: int(1),
    warm_limit: int(1),
  },
  history: {
    startup_mode: { t: 'enum', values: ['accumulate', 'backfill'] },
    lookback_days: num(0),
    candidate_max_age_days: num(1),
    raw_retention_days: num(1),
    candle_1m_retention_days: num(1),
    candle_higher_retention_days: num(1),
    evidence_retention_days: num(1),
  },
  market: {
    series_policy: { t: 'enum', values: ['frozen_pool'] },
    price_conflict_max: ratio(),
    stable_peg_deviation_max: ratio(),
    require_complete_coverage: { t: 'bool' },
    real_bar_ratio_min: ratio(),
  },
  size_band: {
    mode: { t: 'enum', values: ['fdv_proxy', 'volume_usd', 'off'] },
    min_usd: num(0),
    max_usd: num(0),
    volume_window_hours: { t: 'numOrNull', min: 0 },
    volume_in_band_ratio_min: ratio(),
  },
  second_leg: {
    enabled: { t: 'bool' },
    timeframe_seconds: int(60),
    pivot_reversal: ratio(),
    first_leg_multiple_min: num(1),
    first_leg_max_hours: num(0),
    first_pullback_min: ratio(),
    collapse_drawdown: ratio(),
    seed_box_hours: num(0),
    ready_min_hours: num(0),
    ready_max_hours: num(0),
    box_quantiles: { t: 'numArr', len: 2, min: 0, max: 1 },
    box_width_min: ratio(),
    box_width_max: num(0),
    daily_drift_abs_max: num(0),
    inside_padding: ratio(),
    inside_ratio_min: ratio(),
    activity_window_hours: num(0),
    zone_fraction: { t: 'num', min: 0, max: 0.5 },
    zone_visits_min: int(1),
    zone_gap_bars_min: int(0),
    soft_break_max: ratio(),
    soft_break_max_bars: int(0),
    reclaim_deadline_bars: int(0),
    breakout_buffer: ratio(),
    breakout_confirm_bars: int(1),
    breakout_failed_bars: int(1),
  },
  new_pullback: {
    enabled: { t: 'bool' },
    timeframe_seconds: int(60),
    max_age_hours: num(0),
    launch_baseline_real_bars: int(1),
    impulse_multiple_min: num(1),
    impulse_max_minutes: num(0),
    dip_min: ratio(),
    dip_max: ratio(),
    rebound_min: ratio(),
    recovery_fraction_min: ratio(),
    cycle_min_minutes: num(0),
    cycle_max_minutes: num(0),
    second_cycle_gap_real_bars: int(0),
    second_low_ratio_min: ratio(),
    total_max_minutes: num(0),
    max_distance_from_second_low: ratio(),
    invalid_below_second_low: ratio(),
    post_confirm_risk_minutes: num(0),
  },
  million_reclaim: {
    enabled: { t: 'bool' },
    gate_min_usd: num(0),
    gate_max_usd: num(0),
    gate_to_dip_max_minutes: num(0),
    dip_min: ratio(),
    dip_max: ratio(),
    recovery_max_minutes: num(0),
    new_high_buffer: ratio(),
    confirm_bars: int(1),
  },
  rsi: {
    enabled: { t: 'bool' },
    length: int(2, 100),
    smoothing_type: { t: 'enum', values: ['SMA', 'EMA', 'RMA', 'WMA'] },
    smoothing_length: int(1, 100),
    reference_upper: num(0, 100),
    reference_lower: num(0, 100),
    overheat: num(0, 100),
    rearm_below_or_equal: num(0, 100),
    rearm_bars: int(1),
    cooldown_minutes: num(0),
    recommended_warmup_bars: int(1),
    real_activity_window_bars: int(1),
  },
  narrative: {
    provider: { t: 'enum', values: ['manual', 'configured_auto'] },
    required_for_standard_signal: { t: 'bool' },
    allowed_categories: { t: 'enumArr', values: ['technology', 'science', 'stock_related', 'meme', 'other'], min: 1 },
    history_coverage_days_min: num(0),
    independent_sources_min: int(0),
    cache_ttl_hours: num(0),
    timeout_ms: int(1),
    concurrency: int(1, 16),
    min_refresh_minutes: num(0),
    max_requests_per_day: int(0),
    max_tokens_per_day: int(0),
    pending_tg_digest: { t: 'bool' },
  },
  external_candidates: {
    debot_enabled: { t: 'bool' },
    manual_import_enabled: { t: 'bool' },
  },
  notifications: {
    min_gap_ms: int(0),
    new_signal_ttl_minutes: num(0),
    range_ready_ttl_minutes: num(0),
    breakout_ttl_minutes: num(0),
    risk_ttl_minutes: num(0),
    ambiguous_send_policy: { t: 'enum', values: ['manual_reconcile', 'never_resend'] },
    followup_hours: num(0),
    reference_exit_fraction: ratio(),
  },
  render: {
    timezone: { t: 'tz' },
    locale: { t: 'str' },
  },
};

// ── 类型（由 schema 手工镜像；实际保护来自上面的运行时校验） ────────────────

export type SizeBandMode = 'fdv_proxy' | 'volume_usd' | 'off';
export type StartupMode = 'accumulate' | 'backfill';
export type NarrativeProvider = 'manual' | 'configured_auto';

export interface PostConfig {
  version: string;
  chains: number[];
  scan: { realtime_interval_ms: number; closed_bar_grace_seconds: number; historical_concurrency: number; hot_limit: number; warm_limit: number };
  history: { startup_mode: StartupMode; lookback_days: number; candidate_max_age_days: number; raw_retention_days: number; candle_1m_retention_days: number; candle_higher_retention_days: number; evidence_retention_days: number };
  market: { series_policy: 'frozen_pool'; price_conflict_max: number; stable_peg_deviation_max: number; require_complete_coverage: boolean; real_bar_ratio_min: number };
  size_band: { mode: SizeBandMode; min_usd: number; max_usd: number; volume_window_hours: number | null; volume_in_band_ratio_min: number };
  second_leg: Record<string, any> & { enabled: boolean; timeframe_seconds: number; box_quantiles: [number, number] };
  new_pullback: Record<string, any> & { enabled: boolean; timeframe_seconds: number };
  million_reclaim: Record<string, any> & { enabled: boolean };
  rsi: Record<string, any> & { enabled: boolean; length: number };
  narrative: { provider: NarrativeProvider; required_for_standard_signal: boolean; allowed_categories: string[] } & Record<string, any>;
  external_candidates: { debot_enabled: boolean; manual_import_enabled: boolean };
  notifications: Record<string, any> & { min_gap_ms: number; ambiguous_send_policy: string };
  render: { timezone: string; locale: string };
}

/**
 * 没有暴露到 YAML 的固定常量。集中在这里、跟着 configHash 一起版本化，
 * 免得「close ≤ H×0.2 等价于回撤 80%」这种关系在两个模块里写成不同数字。
 */
export const VERSIONED_DEFAULTS = {
  /** §6.2：任何 high 之后 close ≤ H × 这个比例，本次第一波作废。等价于 collapse_drawdown=0.80。 */
  firstLegCollapseCloseRatio: 0.20,
  /** §7.2：百万关口分支同样只对 ≤24h 的新币启用。 */
  millionGateMaxAgeHours: 24,
  /** §5.2：报价必须落在事件时点之前的这个秒数内，否则该笔成交视为无价。 */
  quoteMaxLagSeconds: 120,
  /** §5.2：判定两个池价格冲突的最小持续样本数。 */
  priceConflictMinSamples: 3,
  /** §8：avgGain 与 avgLoss 同时为 0 时的 RSI 取值，本项目约定。 */
  rsiFlatValue: 50,
  /** §5.2：主池选择在新币不足 1h 时允许的最短观察窗口。 */
  primaryPoolMinWindowSeconds: 300,
  /** §5.2：主池选择的默认观察窗口。 */
  primaryPoolWindowSeconds: 3600,
} as const;

// ── 校验 ───────────────────────────────────────────────────────────────────

function checkField(path: string, spec: Spec, v: unknown, errors: string[]): void {
  const bad = (msg: string): void => { errors.push(`${path} ${msg}`); };
  switch (spec.t) {
    case 'num': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad('必须是有限数字');
      if (spec.int && !Number.isInteger(v)) return bad('必须是整数');
      if (spec.min !== undefined && v < spec.min) return bad(`不能小于 ${spec.min}`);
      if (spec.max !== undefined && v > spec.max) return bad(`不能大于 ${spec.max}`);
      return;
    }
    case 'numOrNull': {
      if (v === null || v === undefined) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad('必须是有限数字或 null');
      if (spec.min !== undefined && v < spec.min) return bad(`不能小于 ${spec.min}`);
      return;
    }
    case 'bool': if (typeof v !== 'boolean') bad('必须是布尔值'); return;
    case 'str': if (typeof v !== 'string' || !v) bad('必须是非空字符串'); return;
    case 'enum': if (typeof v !== 'string' || !spec.values.includes(v)) bad(`必须是 ${spec.values.join('/')} 之一`); return;
    case 'tz': {
      if (typeof v !== 'string' || !v) return bad('必须是非空字符串');
      try { new Intl.DateTimeFormat('en', { timeZone: v }).format(); } catch { bad('不是有效时区'); }
      return;
    }
    case 'numArr': {
      if (!Array.isArray(v)) return bad('必须是数组');
      if (spec.len !== undefined && v.length !== spec.len) return bad(`必须有 ${spec.len} 个元素`);
      v.forEach((x, i) => {
        if (typeof x !== 'number' || !Number.isFinite(x)) errors.push(`${path}[${i}] 必须是有限数字`);
        else if (spec.min !== undefined && x <= spec.min) errors.push(`${path}[${i}] 必须大于 ${spec.min}`);
        else if (spec.max !== undefined && x >= spec.max) errors.push(`${path}[${i}] 必须小于 ${spec.max}`);
      });
      return;
    }
    case 'enumArr': {
      if (!Array.isArray(v)) return bad('必须是数组');
      if (spec.min !== undefined && v.length < spec.min) return bad(`至少要有 ${spec.min} 项`);
      for (const x of v) if (typeof x !== 'string' || !spec.values.includes(x)) errors.push(`${path} 含非法取值 ${String(x)}`);
      return;
    }
    case 'intArr': {
      if (!Array.isArray(v) || !v.length) return bad('必须是非空数组');
      v.forEach((x, i) => { if (!Number.isInteger(x)) errors.push(`${path}[${i}] 必须是整数`); });
      return;
    }
  }
}

/** 跨字段约束（§12 末段）。单字段范围过了不代表组合有意义。 */
function crossChecks(c: any, errors: string[]): void {
  const sl = c.second_leg ?? {}, np = c.new_pullback ?? {}, mr = c.million_reclaim ?? {}, rsi = c.rsi ?? {};
  const sb = c.size_band ?? {}, h = c.history ?? {};
  const req = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); };

  req(sb.min_usd < sb.max_usd, 'size_band.min_usd 必须小于 max_usd');
  req(sb.mode !== 'volume_usd' || (typeof sb.volume_window_hours === 'number' && sb.volume_window_hours > 0),
    'size_band.mode=volume_usd 时 volume_window_hours 必须是正数（原文没给这个窗口，必须显式声明）');
  req(sb.mode === 'volume_usd' || sb.volume_window_hours === null || sb.volume_window_hours === undefined,
    'size_band.volume_window_hours 只在 mode=volume_usd 时有意义，其余模式必须为 null');

  req(sl.ready_min_hours < sl.ready_max_hours, 'second_leg.ready_min_hours 必须小于 ready_max_hours');
  req(sl.seed_box_hours < sl.ready_min_hours, 'second_leg.seed_box_hours 必须小于 ready_min_hours');
  req(sl.box_width_min < sl.box_width_max, 'second_leg.box_width_min 必须小于 box_width_max');
  req(Array.isArray(sl.box_quantiles) && sl.box_quantiles[0] < sl.box_quantiles[1],
    'second_leg.box_quantiles 必须升序且在 (0,1) 内');
  req(sl.first_pullback_min < sl.collapse_drawdown,
    'second_leg.first_pullback_min 必须小于 collapse_drawdown，否则任何回撤都会先被判成归零');
  req(Math.abs((1 - sl.collapse_drawdown) - VERSIONED_DEFAULTS.firstLegCollapseCloseRatio) < 1e-9,
    `second_leg.collapse_drawdown 必须与 VERSIONED_DEFAULTS.firstLegCollapseCloseRatio=${VERSIONED_DEFAULTS.firstLegCollapseCloseRatio} 互补（当前 ${sl.collapse_drawdown}）`);

  req(np.dip_min < np.dip_max, 'new_pullback.dip_min 必须小于 dip_max');
  req(np.cycle_min_minutes < np.cycle_max_minutes, 'new_pullback.cycle_min_minutes 必须小于 cycle_max_minutes');
  req(np.total_max_minutes >= np.cycle_max_minutes * 2,
    'new_pullback.total_max_minutes 至少要能容纳两个 cycle_max_minutes，否则第二轮永远超时');
  req(np.max_age_hours <= h.candidate_max_age_days * 24,
    'new_pullback.max_age_hours 不能超过 history.candidate_max_age_days');

  req(mr.gate_min_usd < mr.gate_max_usd, 'million_reclaim.gate_min_usd 必须小于 gate_max_usd');
  req(mr.dip_min < mr.dip_max, 'million_reclaim.dip_min 必须小于 dip_max');

  req(rsi.reference_upper > rsi.reference_lower, 'rsi.reference_upper 必须大于 reference_lower');
  req(rsi.overheat >= rsi.reference_upper, 'rsi.overheat 不能低于 reference_upper');
  req(rsi.rearm_below_or_equal < rsi.overheat, 'rsi.rearm_below_or_equal 必须小于 overheat');
  req(rsi.recommended_warmup_bars >= rsi.length + 1,
    'rsi.recommended_warmup_bars 至少要有 length+1 根，否则连第一个 RSI 都算不出来');

  // 保留窗口必须覆盖策略真正需要的历史，否则会自己把二段的箱体裁掉（§5.4）。
  const readyDays = sl.ready_max_hours / 24;
  req(h.candle_higher_retention_days >= readyDays,
    `history.candle_higher_retention_days 必须覆盖 second_leg.ready_max_hours(${readyDays} 天)`);
  req(h.candle_1m_retention_days >= np.max_age_hours / 24,
    'history.candle_1m_retention_days 必须覆盖 new_pullback.max_age_hours');
  req(h.evidence_retention_days >= h.candle_higher_retention_days,
    'history.evidence_retention_days 不能短于 K 线保留，否则信号会失去可解释证据');
  req(h.startup_mode !== 'backfill' || h.lookback_days > 0,
    'history.startup_mode=backfill 时 lookback_days 必须为正');

  // 关掉叙事硬门只能当实验（§12）。这里强制把版本名改掉，避免仍叫标准 post_v1 确认。
  req(c.narrative?.required_for_standard_signal === true || String(c.version).includes('experimental'),
    'narrative.required_for_standard_signal=false 时 version 必须包含 experimental，不能仍称标准 post_v1');
}

export function validatePostConfig(raw: unknown): { errors: string[]; config?: PostConfig } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['配置根必须是对象'] };
  const c = raw as Record<string, any>;

  if (c.version !== 'post_v1' && !String(c.version ?? '').startsWith('post_v1'))
    errors.push('version 必须以 post_v1 开头');
  if (!Array.isArray(c.chains) || !c.chains.length || !c.chains.every((x: unknown) => Number.isInteger(x)))
    errors.push('chains 必须是非空整数数组');

  const known = new Set(['version', 'chains', ...Object.keys(SCHEMA)]);
  for (const k of Object.keys(c)) if (!known.has(k)) errors.push(`未知配置项 ${k}`);

  for (const [section, fields] of Object.entries(SCHEMA)) {
    const s = c[section];
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push(`${section} 必须是对象`); continue; }
    for (const k of Object.keys(s)) if (!(k in fields)) errors.push(`未知配置项 ${section}.${k}`);
    for (const [k, spec] of Object.entries(fields)) {
      if (!(k in s)) { errors.push(`${section}.${k} 缺失`); continue; }
      checkField(`${section}.${k}`, spec, s[k], errors);
    }
  }
  if (errors.length) return { errors };
  crossChecks(c, errors);
  return errors.length ? { errors } : { errors: [], config: c as unknown as PostConfig };
}

/**
 * 配置指纹。信号卡片和 episode 都要带上它——阈值改了却看不出来，
 * 历史信号就没法解释是按哪套规则产生的（§10）。
 */
export function configHash(c: unknown): string {
  const stable = (v: any): any => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify({ config: stable(c), defaults: stable(VERSIONED_DEFAULTS) }))
    .digest('hex')
    .slice(0, 8);
}

export const POST_CONFIG_PATH = process.env.POST_CONFIG_FILE
  ? new URL(`../../${process.env.POST_CONFIG_FILE}`, import.meta.url).pathname
  : new URL('../../config/post-strategy.yaml', import.meta.url).pathname;

export function loadPostConfigFile(path = POST_CONFIG_PATH): { errors: string[]; config?: PostConfig; hash?: string } {
  let raw: unknown;
  try { raw = parse(readFileSync(path, 'utf8')); }
  catch (err) { return { errors: [`读取/解析 ${path} 失败: ${String(err).slice(0, 200)}`] }; }
  const r = validatePostConfig(raw);
  return r.config ? { errors: [], config: r.config, hash: configHash(r.config) } : r;
}

let cached: { config: PostConfig; hash: string } | null = null;
/** 加载并缓存。校验不过直接抛——post 模式不允许带着坏配置跑。 */
export function postConfig(): { config: PostConfig; hash: string } {
  if (cached) return cached;
  const r = loadPostConfigFile();
  if (!r.config || !r.hash) throw new Error(`post 配置无效:\n  - ${r.errors.join('\n  - ')}`);
  cached = { config: r.config, hash: r.hash };
  return cached;
}
/** 测试用：换一份配置后清缓存。 */
export function resetPostConfigCache(): void { cached = null; }
