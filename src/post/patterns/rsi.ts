/**
 * RSI(9) 与过热提醒（设计文档 §8）。
 *
 * 实现按 Wilder RMA：最初 n 个 delta 用算术均值初始化 avgGain/avgLoss，
 * 之后 `(prev×(n-1) + current)/n`。
 *
 * 帖子写的「9/9」无法确认第二个 9 是什么设置，所以这里把它实现成 TradingView
 * 意义上的**额外平滑线**（对 RSI 序列再做 SMA9），仅供显示，不参与 90 阈值判定，
 * 也**不是**第二次计算 RSI，更不是 Stoch RSI。卡片必须注明这是暂定口径。
 *
 * 边界约定：avgLoss=0 且 avgGain>0 → 100；avgGain=0 且 avgLoss>0 → 0；
 * 两者均为 0 → 50（本项目约定，必须写在卡片和文档里）。
 */
import type { Candle, Evaluation } from '../types.js';
import { pass, unknown as unk } from '../types.js';
import { isRealBar } from './pivots.js';
import { VERSIONED_DEFAULTS } from '../config.js';

export interface RsiPoint { barCloseTs: number; rsi: number; smoothed: number | null }

export interface RsiConfig {
  length: number;
  smoothing_type: string;
  smoothing_length: number;
  reference_upper: number;
  reference_lower: number;
  overheat: number;
  rearm_below_or_equal: number;
  rearm_bars: number;
  cooldown_minutes: number;
  recommended_warmup_bars: number;
  real_activity_window_bars: number;
}

/**
 * 计算 RSI 序列。
 *
 * 输入必须是**时间上连续**的 close：synthetic 平线可以用来维持时间周期
 * （§5.2 明确允许），但真实交易覆盖不足时不得据此发过热事件——那由
 * `detectOverheat` 的活跃度门单独把关。unknown 桶会中断序列并重新预热。
 */
export function computeRsi(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < length + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain += Math.max(d, 0);
    avgLoss += Math.max(-d, 0);
  }
  avgGain /= length; avgLoss /= length;
  out[length] = rsiValue(avgGain, avgLoss);
  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (length - 1) + Math.max(d, 0)) / length;
    avgLoss = (avgLoss * (length - 1) + Math.max(-d, 0)) / length;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0 && avgGain === 0) return VERSIONED_DEFAULTS.rsiFlatValue;   // 本项目约定
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** 对 RSI 序列再做一次简单平均（仅显示用，不参与阈值）。 */
export function smoothSeries(values: (number | null)[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const buf: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) { buf.length = 0; continue; }   // 序列断了就重新累计
    buf.push(v);
    if (buf.length > length) buf.shift();
    if (buf.length === length) out[i] = buf.reduce((s, x) => s + x, 0) / length;
  }
  return out;
}

export interface RsiSeries {
  points: RsiPoint[];
  warmupBars: number;
  shortWarmup: boolean;
  realRatioRecent: number;
  timeframeSec: number;
}

/** 从 K 线算出 RSI 序列。遇到 unknown 桶会截断并从后面重新预热。 */
export function rsiFromCandles(bars: Candle[], cfg: RsiConfig): RsiSeries {
  // 只保留连续的一段：unknown 会打断序列，取最后一段连续数据。
  let start = 0;
  bars.forEach((b, i) => { if (b.quality === 'unknown') start = i + 1; });
  const seg = bars.slice(start).filter(b => b.closed && b.quality !== 'unknown');
  const closes = seg.map(b => b.close);
  const rsi = computeRsi(closes, cfg.length);
  const sma = smoothSeries(rsi, cfg.smoothing_length);
  const points: RsiPoint[] = [];
  seg.forEach((b, i) => {
    if (rsi[i] === null) return;
    points.push({ barCloseTs: b.closeTs, rsi: rsi[i]!, smoothed: sma[i] ?? null });
  });
  const recent = seg.slice(-cfg.real_activity_window_bars);
  return {
    points,
    warmupBars: seg.length,
    shortWarmup: seg.length < cfg.recommended_warmup_bars,
    realRatioRecent: recent.length ? recent.filter(isRealBar).length / recent.length : 0,
    timeframeSec: bars[0]?.timeframeSec ?? 0,
  };
}

export interface OverheatState {
  armed: boolean;                 // 是否可以再次触发
  lastEventTs: number | null;
  belowRun: number;
  firstObservation: boolean;      // 初次开始跟踪时就已 ≥90
}

export const emptyOverheatState = (): OverheatState =>
  ({ armed: true, lastEventTs: null, belowRun: 0, firstObservation: false });

export interface OverheatEvent {
  type: 'RSI_OVERHEAT';
  barCloseTs: number;
  rsi: number;
  smoothed: number | null;
  firstObservation: boolean;
  reason: string;
  text: string;
}

export interface OverheatResult {
  state: OverheatState;
  events: OverheatEvent[];
  evaluations: Evaluation[];
}

/**
 * 过热事件。
 *
 * - raw RSI 首次从 <90 上穿到 ≥90 才发；SMA9 不参与这条阈值。
 * - 持续 ≥90 不重复。
 * - 重新武装：raw RSI 连续 2 根 ≤80 **且** 距上次事件至少 cooldown 分钟。
 * - 初次开始跟踪时已经 ≥90，可以发一次「首次观测已过热」，但不能冒称刚上穿。
 * - 最近 N 根目标周期桶真实成交不足 70% 时只本地记录，不发事件（避免拿
 *   synthetic 平线算出来的 RSI 刷屏）。
 */
export function detectOverheat(series: RsiSeries, cfg: RsiConfig, state = emptyOverheatState()): OverheatResult {
  const events: OverheatEvent[] = [];
  const evaluations: Evaluation[] = [];
  let s = { ...state };

  if (!series.points.length) {
    evaluations.push(unk('rsi.warmup', 0, cfg.length + 1, '连续 close 不足，还算不出第一个 RSI', 0));
    return { state: s, events, evaluations };
  }
  const tfLabel = series.timeframeSec >= 3600 ? `${series.timeframeSec / 3600}h`
    : series.timeframeSec >= 60 ? `${series.timeframeSec / 60}m` : `${series.timeframeSec}s`;

  const activityOk = series.realRatioRecent >= 0.70;
  if (!activityOk) {
    evaluations.push(unk('rsi.real_activity', round(series.realRatioRecent), 0.70,
      `最近 ${cfg.real_activity_window_bars} 根真实成交桶只有 ${pct(series.realRatioRecent)}，只本地记录不发事件`,
      series.points[series.points.length - 1]!.barCloseTs));
  }
  if (series.shortWarmup) {
    evaluations.push(unk('rsi.warmup', series.warmupBars, cfg.recommended_warmup_bars,
      `short_warmup：只累计 ${series.warmupBars} 根，低于建议的 ${cfg.recommended_warmup_bars} 根稳定预热`,
      series.points[series.points.length - 1]!.barCloseTs));
  }

  let prev: number | null = null;
  for (const p of series.points) {
    const hot = p.rsi >= cfg.overheat;
    if (hot) {
      const crossed = prev !== null && prev < cfg.overheat;
      const firstObservation = prev === null;            // 一开始就在过热区
      if (s.armed && (crossed || firstObservation)) {
        const cooled = s.lastEventTs === null || p.barCloseTs - s.lastEventTs >= cfg.cooldown_minutes * 60_000;
        if (cooled && activityOk) {
          events.push({
            type: 'RSI_OVERHEAT', barCloseTs: p.barCloseTs, rsi: p.rsi, smoothed: p.smoothed,
            firstObservation,
            reason: firstObservation ? '开始跟踪时 RSI 已在过热区（不是刚上穿）' : `raw RSI 首次从 <${cfg.overheat} 进入 ≥${cfg.overheat}`,
            text: `RSI(${cfg.length}, ${tfLabel})=${p.rsi.toFixed(1)}，${firstObservation ? '首次观测已过热' : `进入过热区`}；请结合持仓检查是否分批减仓。`,
          });
          s = { ...s, armed: false, lastEventTs: p.barCloseTs, belowRun: 0, firstObservation };
        }
      }
      // 持续 ≥90 不重复触发
      s.belowRun = 0;
    } else {
      if (p.rsi <= cfg.rearm_below_or_equal) {
        s.belowRun++;
        const cooled = s.lastEventTs === null || p.barCloseTs - s.lastEventTs >= cfg.cooldown_minutes * 60_000;
        if (s.belowRun >= cfg.rearm_bars && cooled) s.armed = true;
      } else s.belowRun = 0;
    }
    prev = p.rsi;
  }

  const last = series.points[series.points.length - 1]!;
  evaluations.push(pass('rsi.value', round(last.rsi), { upper: cfg.reference_upper, lower: cfg.reference_lower, overheat: cfg.overheat },
    `RSI(${cfg.length}, ${tfLabel})=${last.rsi.toFixed(1)}；${cfg.reference_upper}/${cfg.reference_lower} 只是参考线，` +
    `RSI<${cfg.reference_lower} 不自动产生抄底信号，${cfg.overheat} 也不是顶部保证`, last.barCloseTs));

  return { state: s, events, evaluations };
}

const round = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
