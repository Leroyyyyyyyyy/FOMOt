/**
 * 策略 A：二段横盘 SECOND_LEG（设计文档 §6）。
 *
 * 纯函数：输入 15m 已收盘 K 线 + 配置，输出状态、逐条 evaluation 和待发事件。
 * 不碰网络、不写库、不发消息——这样同一段数据无论回放多少次都得到同一结果。
 *
 * 除 48–96h 之外的阈值都是**待回放校准的工程初值**，不是作者给的精确公式；
 * 这里做的是可解释、因果、不重绘的近似，不是「精确复刻主观读图」。
 */
import type { Candle, Evaluation } from '../types.js';
import { pass, fail, unknown as unk } from '../types.js';
import { emptyPivotState, stepPivot, isRealBar, quantile, median, olsSlopePerHour, type Pivot, type PivotState } from './pivots.js';

const H = 3600_000;

export type SecondLegPhase =
  | 'FIRST_LEG_TRACKING' | 'RETRACED' | 'BUILDING_RANGE' | 'RANGE_TRACKING'
  | 'READY' | 'BREAKOUT_CONFIRMED' | 'INVALIDATED' | 'EXPIRED' | 'RANGE_REJECTED';

export interface FirstLeg {
  lowPrice: number; lowTs: number;
  highPrice: number; highTs: number;
  highConfirmedAt: number;
  multiple: number;
  hours: number;
  /** 25% 回撤首次成立的那根 15m close 的收盘时间，也就是箱体时钟起点。 */
  retracedAt: number;
  maxDrawdown: number;
}

export interface Box {
  lower: number; upper: number; mid: number;
  width: number; slope24h: number;
  realBarRatio: number;
  builtAt: number;          // 建箱 24h 完成那一刻
  bars: number;
}

export interface SecondLegEvent {
  type: 'SECOND_LEG_READY' | 'SECOND_LEG_BREAKOUT' | 'SECOND_LEG_INVALIDATED'
      | 'SECOND_LEG_EXPIRED' | 'BREAKOUT_FAILED';
  barCloseTs: number;
  reason: string;
  snapshot: Record<string, unknown>;
}

export interface SecondLegConfig {
  timeframe_seconds: number;
  pivot_reversal: number;
  first_leg_multiple_min: number;
  first_leg_max_hours: number;
  first_pullback_min: number;
  collapse_drawdown: number;
  seed_box_hours: number;
  ready_min_hours: number;
  ready_max_hours: number;
  box_quantiles: [number, number];
  box_width_min: number;
  box_width_max: number;
  daily_drift_abs_max: number;
  inside_padding: number;
  inside_ratio_min: number;
  activity_window_hours: number;
  zone_fraction: number;
  zone_visits_min: number;
  zone_gap_bars_min: number;
  soft_break_max: number;
  soft_break_max_bars: number;
  reclaim_deadline_bars: number;
  breakout_buffer: number;
  breakout_confirm_bars: number;
  breakout_failed_bars: number;
}

export interface SecondLegResult {
  phase: SecondLegPhase;
  reason: string;
  firstLeg: FirstLeg | null;
  rangeStartTs: number | null;
  box: Box | null;
  rangeAgeHours: number | null;
  zoneVisits: number;
  insideRatio: number | null;
  reclaimPending: boolean;
  earlyBreakout: boolean;
  readyAt: number | null;
  breakoutAt: number | null;
  evaluations: Evaluation[];
  events: SecondLegEvent[];
  /** 本轮实际参与判定的最后一根 K，写进 episode 的 last_processed_bar。 */
  lastBarTs: number | null;
}

interface Candidate { low: Pivot; high: Pivot }

/** 箱体上下沿与漂移。只用非 synthetic 的真实 close（§6.3）。 */
export function buildBox(bars: Candle[], rangeStartTs: number, cfg: SecondLegConfig): Box | null {
  const real = bars.filter(isRealBar);
  if (!real.length) return null;
  const closes = real.map(b => b.close);
  const [ql, qu] = cfg.box_quantiles;
  const lower = quantile(closes, ql);
  const upper = quantile(closes, qu);
  const mid = median(closes);
  if (!(mid > 0)) return null;
  const slopePerHour = olsSlopePerHour(real.map(b => ({ hours: (b.closeTs - rangeStartTs) / H, value: b.close })));
  const expected = Math.round(cfg.seed_box_hours * H / (cfg.timeframe_seconds * 1000));
  return {
    lower, upper, mid,
    width: (upper - lower) / mid,
    slope24h: slopePerHour * 24 / mid,
    realBarRatio: real.length / Math.max(expected, 1),
    builtAt: bars[bars.length - 1]!.closeTs,
    bars: real.length,
  };
}

/** 箱内收盘占比：落在 [(1-p)·L, (1+p)·U] 内的真实 close 比例。 */
function insideRatioOf(bars: Candle[], box: Box, padding: number): number {
  const real = bars.filter(isRealBar);
  if (!real.length) return 0;
  const lo = box.lower * (1 - padding), hi = box.upper * (1 + padding);
  return real.filter(b => b.close >= lo && b.close <= hi).length / real.length;
}

/** 每个滚动 window 小时内真实成交桶的最低占比。低于门槛说明那段其实没人交易。 */
function minRollingRealRatio(bars: Candle[], windowHours: number, tfSec: number): number {
  const per = Math.round(windowHours * H / (tfSec * 1000));
  if (bars.length < per) return bars.length ? bars.filter(isRealBar).length / bars.length : 0;
  let worst = 1;
  for (let i = 0; i + per <= bars.length; i++) {
    const w = bars.slice(i, i + per);
    worst = Math.min(worst, w.filter(isRealBar).length / per);
  }
  return worst;
}

/** 区域往返次数。同一区连续多根只算一次，跨区确认至少间隔 zone_gap_bars_min 根。 */
export function countZoneVisits(bars: Candle[], box: Box, cfg: SecondLegConfig): number {
  const span = box.upper - box.lower;
  const loEdge = box.lower + cfg.zone_fraction * span;
  const hiEdge = box.upper - cfg.zone_fraction * span;
  let visits = 0;
  let lastZone: 'lower' | 'upper' | null = null;
  let lastIdx = -Infinity;
  bars.forEach((b, i) => {
    if (!isRealBar(b)) return;
    const zone = b.close <= loEdge ? 'lower' : b.close >= hiEdge ? 'upper' : null;
    if (!zone) return;
    if (lastZone === null) { visits = 1; lastZone = zone; lastIdx = i; return; }
    if (zone === lastZone) return;                       // 同一区连续多根只算一次
    if (i - lastIdx < cfg.zone_gap_bars_min) return;     // 跨区太快不算一次真实往返
    visits++; lastZone = zone; lastIdx = i;
  });
  return visits;
}

/**
 * 跑完整段 15m K 线。
 *
 * 采用「有界窗口内完整重算」而不是增量累加器：一个 episode 的窗口上限是
 * 第一波 ≤24h + 箱体 ≤96h ≈ 480 根 15m，重算成本可以忽略，换来的是
 * **回放与实时严格同构**——同一根闭合 K 重复处理不会二次计数 pivot 或重复建箱。
 */
export function runSecondLeg(bars: Candle[], cfg: SecondLegConfig): SecondLegResult {
  const evaluations: Evaluation[] = [];
  const events: SecondLegEvent[] = [];
  const collapseRatio = 1 - cfg.collapse_drawdown;

  let pivot: PivotState = emptyPivotState();
  const candidates: Candidate[] = [];
  let firstLeg: FirstLeg | null = null;
  let rangeStartTs: number | null = null;
  let rangeStartIdx = -1;
  let box: Box | null = null;
  let phase: SecondLegPhase = 'FIRST_LEG_TRACKING';
  let reason = '等待第一波：还没有满足 low→high 的已确认节点';
  let softRun = 0, reclaimPending = false;
  let breakoutRun = 0, failRun = 0;
  let readyAt: number | null = null, breakoutAt: number | null = null;
  let earlyBreakout = false;
  let zoneVisits = 0, insideRatio: number | null = null;
  let lastBarTs: number | null = null;
  let sawUnknownInRange = false;

  const terminal = () => phase === 'INVALIDATED' || phase === 'EXPIRED' || phase === 'RANGE_REJECTED';

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    if (terminal()) break;
    if (bar.closed === false) continue;                  // 只吃已收盘的桶
    lastBarTs = bar.closeTs;

    // ── 1. 数据完整度。缺口段内不得确认任何形态。
    if (bar.quality === 'unknown') {
      if (rangeStartTs !== null) sawUnknownInRange = true;
      pivot = stepPivot(pivot, bar, cfg.pivot_reversal).state;   // 会重置未确认节点
      continue;
    }

    // ── 2. pivot 与第一波候选
    if (!firstLeg) {
      const step = stepPivot(pivot, bar, cfg.pivot_reversal);
      pivot = step.state;
      if (step.confirmed?.kind === 'high') {
        const high = step.confirmed;
        // 优先用已确认的低点；没有就用 §6.2 的初始化低点（当时就知道，不是前视）。
        const confirmedLow = [...pivot.pivots].reverse().find(p => p.kind === 'low' && p.extremeTs < high.extremeTs);
        const low: Pivot | null = confirmedLow ?? (pivot.origin && pivot.origin.ts < high.extremeTs
          ? { kind: 'low', price: pivot.origin.price, extremeTs: pivot.origin.ts, confirmedAt: pivot.origin.ts }
          : null);
        if (low && low.price > 0) {
          const multiple = high.price / low.price;
          const hours = (high.extremeTs - low.extremeTs) / H;
          if (multiple >= cfg.first_leg_multiple_min && hours <= cfg.first_leg_max_hours) {
            candidates.push({ low, high });
          } else {
            evaluations.push(fail('second_leg.first_leg', { multiple: round(multiple), hours: round(hours) },
              { multipleMin: cfg.first_leg_multiple_min, maxHours: cfg.first_leg_max_hours },
              `已确认的 low→high 不满足前置拉升（${round(multiple)}× / ${round(hours)}h）`, bar.closeTs));
          }
        }
      }
      // 候选的归零判定与激活
      for (let c = candidates.length - 1; c >= 0; c--) {
        const cand = candidates[c]!;
        if (bar.closeTs <= cand.high.extremeTs) continue;
        if (bar.close <= cand.high.price * collapseRatio) {
          candidates.splice(c, 1);
          evaluations.push(fail('second_leg.collapse', round(bar.close / cand.high.price),
            { closeRatioMax: collapseRatio },
            `第一波高点后收盘累计回撤 ≥${Math.round(cfg.collapse_drawdown * 100)}%，不做「归零反弹二段」`, bar.closeTs));
          continue;
        }
        const drawdown = 1 - bar.close / cand.high.price;
        if (drawdown >= cfg.first_pullback_min) {
          firstLeg = {
            lowPrice: cand.low.price, lowTs: cand.low.extremeTs,
            highPrice: cand.high.price, highTs: cand.high.extremeTs,
            highConfirmedAt: cand.high.confirmedAt,
            multiple: cand.high.price / cand.low.price,
            hours: (cand.high.extremeTs - cand.low.extremeTs) / H,
            retracedAt: bar.closeTs,
            maxDrawdown: drawdown,
          };
          rangeStartTs = bar.closeTs;
          rangeStartIdx = i;
          phase = 'BUILDING_RANGE';
          reason = `第一波 ${round(firstLeg.multiple)}×，回撤 ${pct(drawdown)} 成立，箱体时钟起算`;
          evaluations.push(pass('second_leg.first_leg',
            { multiple: round(firstLeg.multiple), hours: round(firstLeg.hours), pullback: round(drawdown) },
            { multipleMin: cfg.first_leg_multiple_min, maxHours: cfg.first_leg_max_hours, pullbackMin: cfg.first_pullback_min },
            reason, bar.closeTs));
          break;
        }
      }
      continue;
    }

    // ── 3. 已激活第一波：归零判定继续生效，直到终态
    if (bar.close <= firstLeg.highPrice * collapseRatio) {
      phase = 'INVALIDATED';
      reason = `收盘跌到第一波高点的 ${pct(bar.close / firstLeg.highPrice)}，深跌排除`;
      events.push({ type: 'SECOND_LEG_INVALIDATED', barCloseTs: bar.closeTs, reason, snapshot: { close: bar.close, highPrice: firstLeg.highPrice } });
      evaluations.push(fail('second_leg.collapse', round(bar.close / firstLeg.highPrice), { closeRatioMax: collapseRatio }, reason, bar.closeTs));
      break;
    }
    // 更新最大回撤（卡片要显示「其后最大收盘回撤」）
    firstLeg.maxDrawdown = Math.max(firstLeg.maxDrawdown, 1 - bar.close / firstLeg.highPrice);

    const rangeBars = bars.slice(rangeStartIdx + 1, i + 1);
    const rangeAgeHours = (bar.closeTs - rangeStartTs!) / H;

    // ── 4. 建箱窗口
    if (!box) {
      if (rangeAgeHours < cfg.seed_box_hours) {
        phase = 'BUILDING_RANGE';
        reason = `建箱中 ${round(rangeAgeHours)}h / ${cfg.seed_box_hours}h`;
        continue;
      }
      const seed = rangeBars.filter(b => b.closeTs <= rangeStartTs! + cfg.seed_box_hours * H);
      const expected = Math.round(cfg.seed_box_hours * H / (cfg.timeframe_seconds * 1000));
      const built = buildBox(seed, rangeStartTs!, cfg);
      const hasUnknown = seed.some(b => b.quality === 'unknown');
      const realRatio = seed.filter(isRealBar).length / expected;

      if (!built || hasUnknown || seed.length < expected) {
        phase = 'RANGE_REJECTED';
        reason = hasUnknown || seed.length < expected
          ? `建箱 24h 内有未扫描/缺口桶（${seed.length}/${expected}），数据不完整`
          : '建箱窗口内没有真实成交';
        evaluations.push(unk('second_leg.seed_box', { bars: seed.length, expected }, { expected }, reason, bar.closeTs));
        break;
      }
      const widthOk = built.width >= cfg.box_width_min && built.width <= cfg.box_width_max;
      const driftOk = Math.abs(built.slope24h) <= cfg.daily_drift_abs_max;
      const activityOk = realRatio >= 0.70;
      if (!widthOk || !driftOk || !activityOk) {
        phase = 'RANGE_REJECTED';
        reason = !activityOk ? `建箱 24h 真实成交桶只有 ${pct(realRatio)}，低于 70%，是几乎没交易的平线`
          : !driftOk ? `建箱 24h 日漂移 ${round(built.slope24h)}，超过 ±${cfg.daily_drift_abs_max}，是单边趋势不是横盘`
          : `箱体宽度 ${round(built.width)} 不在 [${cfg.box_width_min}, ${cfg.box_width_max}]`;
        evaluations.push(fail('second_leg.seed_box',
          { width: round(built.width), slope24h: round(built.slope24h), realRatio: round(realRatio) },
          { widthMin: cfg.box_width_min, widthMax: cfg.box_width_max, driftMax: cfg.daily_drift_abs_max, realRatioMin: 0.70 },
          reason, bar.closeTs));
        break;
      }
      box = built;                                        // 冻结，之后不随跌势下移边界
      phase = 'RANGE_TRACKING';
      reason = `箱体已冻结 $${built.lower.toPrecision(4)}–$${built.upper.toPrecision(4)}`;
      evaluations.push(pass('second_leg.seed_box',
        { width: round(built.width), slope24h: round(built.slope24h), realRatio: round(realRatio) },
        { widthMin: cfg.box_width_min, widthMax: cfg.box_width_max, driftMax: cfg.daily_drift_abs_max, realRatioMin: 0.70 },
        reason, bar.closeTs));
      continue;
    }

    // ── 5. 破位（数据/深跌之后，超时之前）
    if (bar.close < box.lower * (1 - cfg.soft_break_max)) {
      phase = 'INVALIDATED';
      reason = `收盘 $${bar.close.toPrecision(4)} 跌破箱底 ${pct(1 - cfg.soft_break_max)} 容忍线`;
      events.push({ type: 'SECOND_LEG_INVALIDATED', barCloseTs: bar.closeTs, reason, snapshot: { close: bar.close, lower: box.lower } });
      break;
    }
    if (bar.close < box.lower) {
      softRun++;
      reclaimPending = true;
      if (softRun > cfg.soft_break_max_bars) {
        phase = 'INVALIDATED';
        reason = `连续 ${softRun} 根 15m 收盘跌破箱底，超过 ${cfg.soft_break_max_bars} 根容忍`;
        events.push({ type: 'SECOND_LEG_INVALIDATED', barCloseTs: bar.closeTs, reason, snapshot: { close: bar.close, lower: box.lower, bars: softRun } });
        break;
      }
    } else {
      softRun = 0;
      reclaimPending = false;
    }

    // ── 6. 超时
    if (rangeAgeHours > cfg.ready_max_hours && breakoutAt === null) {
      phase = 'EXPIRED';
      reason = `箱体已横 ${round(rangeAgeHours)}h，超过 ${cfg.ready_max_hours}h 仍未突破`;
      events.push({ type: 'SECOND_LEG_EXPIRED', barCloseTs: bar.closeTs, reason, snapshot: { rangeAgeHours: round(rangeAgeHours) } });
      break;
    }

    // ── 7. 持续箱体质量
    insideRatio = insideRatioOf(rangeBars, box, cfg.inside_padding);
    const ongoing = buildBox(rangeBars, rangeStartTs!, cfg);
    const drift = ongoing ? ongoing.slope24h : 0;
    const rollingReal = minRollingRealRatio(rangeBars, cfg.activity_window_hours, cfg.timeframe_seconds);
    zoneVisits = countZoneVisits(rangeBars, box, cfg);

    // ── 8. 突破（先于 READY 判定：突破必须发生在未过期的 READY 箱体中）
    if (bar.close > box.upper * (1 + cfg.breakout_buffer) && isRealBar(bar)) {
      breakoutRun++;
      if (breakoutRun >= cfg.breakout_confirm_bars && breakoutAt === null) {
        if (rangeAgeHours < cfg.ready_min_hours) {
          earlyBreakout = true;                            // 只记录，不伪装成熟二段
          evaluations.push(fail('second_leg.breakout_timing', round(rangeAgeHours),
            { readyMin: cfg.ready_min_hours }, '48h 以前就突破，记 early_breakout，不当成熟二段', bar.closeTs));
        } else if (rangeAgeHours > cfg.ready_max_hours) {
          phase = 'EXPIRED';
          reason = `两根确认完成时已横 ${round(rangeAgeHours)}h，超过 ${cfg.ready_max_hours}h，只记过期`;
          events.push({ type: 'SECOND_LEG_EXPIRED', barCloseTs: bar.closeTs, reason, snapshot: { rangeAgeHours: round(rangeAgeHours) } });
          break;
        } else if (readyAt !== null) {
          breakoutAt = bar.closeTs;
          phase = 'BREAKOUT_CONFIRMED';
          reason = `连续 ${cfg.breakout_confirm_bars} 根 15m 收盘 > 箱顶 ×${1 + cfg.breakout_buffer}`;
          events.push({
            type: 'SECOND_LEG_BREAKOUT', barCloseTs: bar.closeTs, reason,
            snapshot: { close: bar.close, upper: box.upper, rangeAgeHours: round(rangeAgeHours), box },
          });
          continue;
        }
      }
    } else breakoutRun = 0;

    // ── 9. 突破后跟踪 24h
    if (breakoutAt !== null) {
      if (bar.closeTs - breakoutAt > 24 * H) break;
      if (bar.close < box.upper) {
        failRun++;
        if (failRun >= cfg.breakout_failed_bars) {
          reason = `突破后连续 ${failRun} 根 15m 收盘跌回箱顶之下`;
          events.push({ type: 'BREAKOUT_FAILED', barCloseTs: bar.closeTs, reason, snapshot: { close: bar.close, upper: box.upper } });
          break;
        }
      } else failRun = 0;
      continue;
    }

    // ── 10. READY
    const gates: Evaluation[] = [
      sawUnknownInRange
        ? unk('second_leg.data', 'has_gap', 'no_gap', '箱体期间存在未扫描/缺口桶，缺口补齐前不发确认', bar.closeTs)
        : pass('second_leg.data', 'complete', 'complete', '箱体期间扫描连续无缺口', bar.closeTs),
      check('second_leg.inside_ratio', insideRatio >= cfg.inside_ratio_min, round(insideRatio), cfg.inside_ratio_min,
        `箱内收盘 ${pct(insideRatio)}（门槛 ${pct(cfg.inside_ratio_min)}）`, bar.closeTs),
      check('second_leg.drift', Math.abs(drift) <= cfg.daily_drift_abs_max, round(drift), cfg.daily_drift_abs_max,
        `整段日漂移 ${round(drift)}（上限 ±${cfg.daily_drift_abs_max}）`, bar.closeTs),
      check('second_leg.rolling_activity', rollingReal >= 0.70, round(rollingReal), 0.70,
        `最差 ${cfg.activity_window_hours}h 窗口真实成交桶 ${pct(rollingReal)}`, bar.closeTs),
      check('second_leg.zone_visits', zoneVisits >= cfg.zone_visits_min, zoneVisits, cfg.zone_visits_min,
        `区域往返 ${zoneVisits} 次（门槛 ${cfg.zone_visits_min}）`, bar.closeTs),
      check('second_leg.reclaim', !reclaimPending, reclaimPending ? 'reclaim_pending' : 'clear', 'clear',
        reclaimPending ? '正在等待收回箱底，收回前不发确认' : '未处于破位待收回状态', bar.closeTs),
      check('second_leg.range_age', rangeAgeHours >= cfg.ready_min_hours && rangeAgeHours <= cfg.ready_max_hours,
        round(rangeAgeHours), { min: cfg.ready_min_hours, max: cfg.ready_max_hours },
        `已横盘 ${round(rangeAgeHours)}h`, bar.closeTs),
    ];

    if (rangeAgeHours >= cfg.ready_min_hours && readyAt === null) {
      if (gates.every(g => g.result === 'pass')) {
        readyAt = bar.closeTs;
        phase = 'READY';
        reason = `48–96h 窗口内形态成立，已横 ${round(rangeAgeHours)}h`;
        evaluations.push(...gates);
        events.push({
          type: 'SECOND_LEG_READY', barCloseTs: bar.closeTs, reason,
          snapshot: {
            close: bar.close, box, firstLeg, rangeStartTs, rangeAgeHours: round(rangeAgeHours),
            insideRatio: round(insideRatio), zoneVisits,
            invalidBelow: box.lower * (1 - cfg.soft_break_max),
            expiresAt: rangeStartTs! + cfg.ready_max_hours * H,
          },
        });
      } else {
        phase = 'RANGE_TRACKING';
        const blocker = gates.find(g => g.result !== 'pass')!;
        reason = `未发卡：${blocker.reason}`;
      }
    } else if (readyAt !== null) {
      // READY 之后的失效只由硬规则触发（深跌、跌破 0.92×箱底、连续 3 根破位、超时），
      // 它们都在上面已经处理过。箱内占比/漂移/活跃度/往返是**发卡门槛**，
      // 不是失效条件——把研究性统计过滤当失效会制造大量噪音提醒。
      phase = 'READY';
      reason = `READY 跟踪中，已横 ${round(rangeAgeHours)}h`;
    } else {
      phase = 'RANGE_TRACKING';
      reason = `观察中：已横 ${round(rangeAgeHours)}h，未到 ${cfg.ready_min_hours}h`;
    }
  }

  // 最后一轮的完整 evaluation 也要留下来，才能回答「为什么没推」。
  if (phase === 'FIRST_LEG_TRACKING') {
    evaluations.push(unk('second_leg.first_leg', null, { multipleMin: cfg.first_leg_multiple_min },
      'missing_first_leg：没有第一波覆盖，不能只看横盘就认定二段', lastBarTs ?? 0));
  }

  return {
    phase, reason, firstLeg, rangeStartTs, box,
    rangeAgeHours: rangeStartTs !== null && lastBarTs !== null ? (lastBarTs - rangeStartTs) / H : null,
    zoneVisits, insideRatio, reclaimPending, earlyBreakout, readyAt, breakoutAt,
    evaluations, events, lastBarTs,
  };
}

function check(rule: string, ok: boolean, observed: unknown, threshold: unknown, reason: string, asOf: number): Evaluation {
  return ok ? pass(rule, observed, threshold, reason, asOf) : fail(rule, observed, threshold, reason, asOf);
}
const round = (n: number) => Math.round(n * 10000) / 10000;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
