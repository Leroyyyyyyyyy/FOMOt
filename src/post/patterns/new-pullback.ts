/**
 * 策略 B：新币两个完整回撤周期 NEW_PULLBACK（设计文档 §7.1）。
 *
 * 「连续两根红 K」不等于「两次回撤」。这里要求两个**顺序确认、互不复用低点**的
 * 完整周期：跌够幅度 → 从低点反弹够幅度并收复足够比例 → 才算一轮。
 * 第三次下跌是风险提醒，不是新的入场条件。
 */
import type { Candle, Evaluation } from '../types.js';
import { pass, fail, unknown as unk } from '../types.js';
import { isRealBar, median } from './pivots.js';

const MIN = 60_000;

export type NewPullbackPhase =
  | 'PENDING_HISTORY' | 'IMPULSE' | 'DIP1' | 'REBOUND1' | 'DIP2' | 'REBOUND2'
  | 'CONFIRMED' | 'DEEP_DUMP' | 'EXTENDED_REBOUND' | 'TIMED_OUT' | 'NO_IMPULSE' | 'INVALIDATED';

export interface Cycle {
  peak: number; peakTs: number;
  low: number; lowTs: number;
  dipStartTs: number;
  confirmedAt: number | null;
  dipDepth: number;
  reboundFromLow: number;
  recoveredFraction: number;
}

export interface NewPullbackConfig {
  timeframe_seconds: number;
  max_age_hours: number;
  launch_baseline_real_bars: number;
  impulse_multiple_min: number;
  impulse_max_minutes: number;
  dip_min: number;
  dip_max: number;
  rebound_min: number;
  recovery_fraction_min: number;
  cycle_min_minutes: number;
  cycle_max_minutes: number;
  second_cycle_gap_real_bars: number;
  second_low_ratio_min: number;
  total_max_minutes: number;
  max_distance_from_second_low: number;
  invalid_below_second_low: number;
  post_confirm_risk_minutes: number;
}

export interface NewPullbackEvent {
  type: 'NEW_PULLBACK_CONFIRMED' | 'THIRD_DIP_RISK' | 'STRUCTURE_INVALIDATED';
  barCloseTs: number;
  reason: string;
  snapshot: Record<string, unknown>;
}

export interface NewPullbackResult {
  phase: NewPullbackPhase;
  reason: string;
  baseline: number | null;
  impulseHigh: number | null;
  impulseHighTs: number | null;
  cycles: Cycle[];
  confirmedAt: number | null;
  distanceFromSecondLow: number | null;
  evaluations: Evaluation[];
  events: NewPullbackEvent[];
  lastBarTs: number | null;
}

export interface NewPullbackContext {
  /** 该代币最早可信成交时间。只知道池龄、不知道 token 更早是否交易时传 null。 */
  firstTradeTs: number | null;
  ageQuality: 'verified' | 'age_unverified' | 'unknown';
}

/**
 * `bars` 必须是从 firstTradeTs 起的连续 1m 已收盘 K。
 * 早期段缺失就是 `missing_launch_history`——不能拿「被发现后的第一笔」当发行价。
 */
export function runNewPullback(bars: Candle[], cfg: NewPullbackConfig, ctx: NewPullbackContext): NewPullbackResult {
  const evaluations: Evaluation[] = [];
  const events: NewPullbackEvent[] = [];
  const cycles: Cycle[] = [];
  const empty = (phase: NewPullbackPhase, reason: string): NewPullbackResult => ({
    phase, reason, baseline: null, impulseHigh: null, impulseHighTs: null, cycles: [],
    confirmedAt: null, distanceFromSecondLow: null, evaluations, events,
    lastBarTs: bars.length ? bars[bars.length - 1]!.closeTs : null,
  });

  if (ctx.firstTradeTs === null || ctx.ageQuality !== 'verified') {
    evaluations.push(unk('new_pullback.age', ctx.ageQuality, 'verified',
      'age_unverified：只知道某个新池的年龄，无法确认该 token 更早是否交易过，不能当新币', 0));
    return empty('PENDING_HISTORY', 'age_unverified：币龄证据不足');
  }

  const real = bars.filter(isRealBar);
  if (real.length < cfg.launch_baseline_real_bars) {
    evaluations.push(unk('new_pullback.launch_history', real.length, cfg.launch_baseline_real_bars,
      `missing_launch_history：只有 ${real.length} 根真实 1m K，不足 ${cfg.launch_baseline_real_bars} 根`, 0));
    return empty('PENDING_HISTORY', 'missing_launch_history：发行早期段还不够');
  }

  // B = 最初 N 根真实 1m close 的中位数；**第 N 根收盘后**才可用。
  const baseBars = real.slice(0, cfg.launch_baseline_real_bars);
  const baseline = median(baseBars.map(b => b.close));
  const baselineAvailableAt = baseBars[baseBars.length - 1]!.closeTs;
  if (!(baseline > 0)) return empty('PENDING_HISTORY', '基准价无效');

  const impulseDeadline = ctx.firstTradeTs + cfg.impulse_max_minutes * MIN;

  let phase: NewPullbackPhase = 'IMPULSE';
  let reason = '等待发行后 60 分钟内的首波拉升';
  let impulseHigh: number | null = null, impulseHighTs: number | null = null;
  let cur: Cycle | null = null;
  let cyclePeak = 0, cyclePeakTs = 0;
  let cycleFrozen = false;
  let dip1StartTs: number | null = null;
  let confirmedAt: number | null = null;
  let distanceFromSecondLow: number | null = null;
  let postConfirmHigh = 0;
  let thirdDipSent = false;
  let lastBarTs: number | null = null;
  let realSinceRebound1 = 0;

  const terminal = () => ['DEEP_DUMP', 'EXTENDED_REBOUND', 'TIMED_OUT', 'NO_IMPULSE', 'INVALIDATED'].includes(phase);

  for (const bar of bars) {
    if (terminal()) break;
    if (!bar.closed) continue;
    lastBarTs = bar.closeTs;

    if (bar.quality === 'unknown') {
      // 数据故障就是数据故障，不能当「风险解除」。
      evaluations.push(unk('new_pullback.data', 'gap', 'complete',
        '该分钟没有可用数据，形态判定暂停（不等于风险解除）', bar.closeTs));
      continue;
    }
    if (!isRealBar(bar)) continue;                  // synthetic 不是形态证据
    if (bar.closeTs <= baselineAvailableAt) continue;   // B 还没可用，H0 也不能开始跟踪

    // 超过 24h 退出本分支；之后可另开二段 episode。
    if (bar.closeTs - ctx.firstTradeTs > cfg.max_age_hours * 3600_000) {
      if (confirmedAt === null) {
        phase = 'TIMED_OUT';
        reason = `已超过 ${cfg.max_age_hours}h 币龄上限，退出新币分支`;
      }
      break;
    }

    // ── 首波拉升 H0
    if (impulseHigh === null) {
      // H0 是 B 可用之后的 running high；任一根 close 达到 2×B 即成立。
      if (bar.close / baseline >= cfg.impulse_multiple_min) {
        impulseHigh = bar.close; impulseHighTs = bar.closeTs;
        cyclePeak = bar.close; cyclePeakTs = bar.closeTs;
        evaluations.push(pass('new_pullback.impulse', round(bar.close / baseline), cfg.impulse_multiple_min,
          `发行后 ${Math.round((bar.closeTs - ctx.firstTradeTs) / MIN)} 分钟内拉升 ${round(bar.close / baseline)}×`, bar.closeTs));
        phase = 'DIP1';
        reason = '首波拉升成立，等待第一次回撤';
        continue;
      }
      if (bar.closeTs > impulseDeadline) {
        phase = 'NO_IMPULSE';
        reason = `发行后 ${cfg.impulse_max_minutes} 分钟内没有 ${cfg.impulse_multiple_min}× 拉升`;
        evaluations.push(fail('new_pullback.impulse', round(bar.close / baseline), cfg.impulse_multiple_min, reason, bar.closeTs));
        break;
      }
      continue;
    }

    // ── 确认后的跟踪（第三跌风险 / 结构失效）
    if (confirmedAt !== null) {
      const d2 = cycles[1]!.low;
      if (bar.close < d2 * (1 - cfg.invalid_below_second_low)) {
        phase = 'INVALIDATED';
        reason = `收盘跌破第二低点 ×${1 - cfg.invalid_below_second_low}`;
        events.push({ type: 'STRUCTURE_INVALIDATED', barCloseTs: bar.closeTs, reason, snapshot: { close: bar.close, d2 } });
        break;
      }
      if (bar.closeTs - confirmedAt <= cfg.post_confirm_risk_minutes * MIN) {
        postConfirmHigh = Math.max(postConfirmHigh, bar.close);
        if (!thirdDipSent && postConfirmHigh > 0 && (postConfirmHigh - bar.close) / postConfirmHigh >= cfg.dip_min) {
          thirdDipSent = true;
          events.push({
            type: 'THIRD_DIP_RISK', barCloseTs: bar.closeTs,
            reason: `确认后 ${cfg.post_confirm_risk_minutes} 分钟内再次回撤 ≥${pct(cfg.dip_min)}`,
            snapshot: { high: postConfirmHigh, close: bar.close },
          });
        }
      }
      continue;
    }

    // ── 周期状态机
    if (!cur) {
      // 回撤开始前，峰值随新高更新
      if (!cycleFrozen && bar.close > cyclePeak) { cyclePeak = bar.close; cyclePeakTs = bar.closeTs; }
      if (cycles.length === 1) realSinceRebound1++;
      const drop = cyclePeak > 0 ? (cyclePeak - bar.close) / cyclePeak : 0;
      if (drop >= cfg.dip_min) {
        if (cycles.length === 1 && realSinceRebound1 < cfg.second_cycle_gap_real_bars + 1) {
          // DIP2 的第一根必须晚于 REBOUND1 至少 N 根真实 K，不能复用第一轮低点
          continue;
        }
        cycleFrozen = true;
        cur = {
          peak: cyclePeak, peakTs: cyclePeakTs,
          low: bar.close, lowTs: bar.closeTs,
          dipStartTs: bar.closeTs, confirmedAt: null,
          dipDepth: drop, reboundFromLow: 0, recoveredFraction: 0,
        };
        if (cycles.length === 0) dip1StartTs = bar.closeTs;
        phase = cycles.length === 0 ? 'DIP1' : 'DIP2';
        reason = `第 ${cycles.length + 1} 次回撤开始，已跌 ${pct(drop)}`;
      }
      continue;
    }

    // 处于 DIP：更新最低点，检查深跌与反弹确认
    if (bar.close < cur.low) { cur.low = bar.close; cur.lowTs = bar.closeTs; }
    cur.dipDepth = (cur.peak - cur.low) / cur.peak;
    if (cur.dipDepth > cfg.dip_max) {
      phase = 'DEEP_DUMP';
      reason = `回撤 ${pct(cur.dipDepth)} 超过 ${pct(cfg.dip_max)}，deep_dump 失效`;
      evaluations.push(fail('new_pullback.deep_dump', round(cur.dipDepth), cfg.dip_max, reason, bar.closeTs));
      break;
    }

    const reboundFromLow = cur.low > 0 ? (bar.close - cur.low) / cur.low : 0;
    const recovered = cur.peak > cur.low ? (bar.close - cur.low) / (cur.peak - cur.low) : 0;
    const minutes = (bar.closeTs - cur.dipStartTs) / MIN;

    if (minutes > cfg.cycle_max_minutes) {
      phase = 'TIMED_OUT';
      reason = `第 ${cycles.length + 1} 轮从回撤到确认超过 ${cfg.cycle_max_minutes} 分钟`;
      evaluations.push(fail('new_pullback.cycle_time', round(minutes), cfg.cycle_max_minutes, reason, bar.closeTs));
      break;
    }
    if (reboundFromLow < cfg.rebound_min || recovered < cfg.recovery_fraction_min || minutes < cfg.cycle_min_minutes) continue;

    // 反弹确认
    cur.confirmedAt = bar.closeTs;
    cur.reboundFromLow = reboundFromLow;
    cur.recoveredFraction = recovered;
    cycles.push(cur);
    evaluations.push(pass(`new_pullback.cycle${cycles.length}`,
      { dip: round(cur.dipDepth), rebound: round(reboundFromLow), recovered: round(recovered), minutes: round(minutes) },
      { dipMin: cfg.dip_min, reboundMin: cfg.rebound_min, recoveryMin: cfg.recovery_fraction_min, maxMinutes: cfg.cycle_max_minutes },
      `第 ${cycles.length} 轮：回撤 ${pct(cur.dipDepth)} → 收复跌幅 ${pct(recovered)}`, bar.closeTs));

    if (cycles.length === 1) {
      cur = null;
      cycleFrozen = false;
      realSinceRebound1 = 0;
      cyclePeak = bar.close; cyclePeakTs = bar.closeTs;   // 第二周期峰值起点 = 确认反弹的 close
      phase = 'REBOUND1';
      reason = '第一轮确认，等待第二轮回撤';
      continue;
    }

    // ── 第二轮确认：低点关系、总时长、距二低距离
    const d1 = cycles[0]!.low, d2 = cycles[1]!.low;
    const totalMinutes = dip1StartTs === null ? Infinity : (bar.closeTs - dip1StartTs) / MIN;
    const distance = (bar.close - d2) / d2;

    const gates: Evaluation[] = [
      d2 >= d1 * cfg.second_low_ratio_min
        ? pass('new_pullback.second_low', round(d2 / d1), cfg.second_low_ratio_min,
            `第二低点是第一低点的 ${round(d2 / d1)}×`, bar.closeTs)
        : fail('new_pullback.second_low', round(d2 / d1), cfg.second_low_ratio_min,
            `第二低点跌破第一低点的 ${cfg.second_low_ratio_min}×，不是「再跌再拉」而是继续下行`, bar.closeTs),
      totalMinutes <= cfg.total_max_minutes
        ? pass('new_pullback.total_time', round(totalMinutes), cfg.total_max_minutes, `两轮合计 ${round(totalMinutes)} 分钟`, bar.closeTs)
        : fail('new_pullback.total_time', round(totalMinutes), cfg.total_max_minutes,
            `两轮合计 ${round(totalMinutes)} 分钟，超过 ${cfg.total_max_minutes}`, bar.closeTs),
      distance <= cfg.max_distance_from_second_low
        ? pass('new_pullback.distance', round(distance), cfg.max_distance_from_second_low,
            `当前距第二低点 +${pct(distance)}`, bar.closeTs)
        : fail('new_pullback.distance', round(distance), cfg.max_distance_from_second_low,
            `extended_rebound：当前已距第二低点 +${pct(distance)}，不追价等待「更确认」`, bar.closeTs),
    ];
    evaluations.push(...gates);

    const blocked = gates.find(g => g.result !== 'pass');
    if (blocked) {
      phase = blocked.rule === 'new_pullback.distance' ? 'EXTENDED_REBOUND'
        : blocked.rule === 'new_pullback.total_time' ? 'TIMED_OUT' : 'INVALIDATED';
      reason = blocked.reason;
      break;
    }

    confirmedAt = bar.closeTs;
    distanceFromSecondLow = distance;
    postConfirmHigh = bar.close;
    phase = 'CONFIRMED';
    reason = `两个完整回撤周期确认，当前距第二低点 +${pct(distance)}`;
    events.push({
      type: 'NEW_PULLBACK_CONFIRMED', barCloseTs: bar.closeTs, reason,
      snapshot: {
        baseline, impulseHigh, impulseHighTs,
        cycle1: cycles[0], cycle2: cycles[1],
        d1, d2, distanceFromSecondLow: round(distance),
        invalidBelow: d2 * (1 - cfg.invalid_below_second_low),
        ageMinutes: Math.round((bar.closeTs - ctx.firstTradeTs) / MIN),
      },
    });
    cur = null;
  }

  if (phase === 'IMPULSE' && impulseHigh === null && !evaluations.some(e => e.rule === 'new_pullback.impulse')) {
    evaluations.push(unk('new_pullback.impulse', null, cfg.impulse_multiple_min,
      '首波拉升还没成立，也还没到 60 分钟窗口末尾', lastBarTs ?? 0));
  }

  return {
    phase, reason, baseline, impulseHigh, impulseHighTs, cycles,
    confirmedAt, distanceFromSecondLow, evaluations, events, lastBarTs,
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
