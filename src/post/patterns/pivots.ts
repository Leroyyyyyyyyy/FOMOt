/**
 * 因果 pivot（设计文档 §6.1）。
 *
 * 「因果」的意思是：一个极值点只有在**后面**出现了足够幅度的反向变动之后才被确认，
 * `extremeTs`（极值发生的时间）与 `confirmedAt`（我们真的知道它是极值的时间）
 * 必须分开记。把 confirmedAt 回填成 extremeTs 再当成可提前交易的信号，
 * 就是把「事后看图」伪装成实时策略——这条线绝不能越。
 *
 * 只用已收盘 close。同一根 K 内先 high 后 low 还是先 low 后 high，从 OHLC 里
 * 根本看不出来，所以形态节点不用影线；影线只作为卡片上的风险提示。
 */
import type { Candle } from '../types.js';

export interface Pivot {
  kind: 'high' | 'low';
  price: number;
  extremeTs: number;      // 极值那根 K 的收盘时间
  confirmedAt: number;    // 确认它是极值的那根 K 的收盘时间，永远 > extremeTs
}

export interface PivotState {
  mode: 'up' | 'down';
  extreme: number;
  extremeTs: number;
  pivots: Pivot[];
  initialized: boolean;
  /**
   * 初始化那根真实 close（§6.2：「以第一个真实 close 初始化低点」）。
   * 它不是被确认出来的 pivot，所以不进 pivots；但它是当时就知道的事实，
   * 第一波在没有更早的已确认低点时可以拿它当起点 L——这不是前视。
   */
  origin: { price: number; ts: number } | null;
  /** 上一根参与计算的真实 K 的收盘时间；用来识别缺口。 */
  lastBarTs: number | null;
}

export const emptyPivotState = (): PivotState =>
  ({ mode: 'up', extreme: 0, extremeTs: 0, pivots: [], initialized: false, origin: null, lastBarTs: null });

/** 一根 K 能否参与形态判定：synthetic 平线和 unknown 都不是证据。 */
export const isRealBar = (c: Candle): boolean =>
  !c.synthetic && c.quality !== 'unknown' && c.swaps > 0 && typeof c.close === 'number' && c.close > 0;

export interface StepResult { state: PivotState; confirmed: Pivot | null }

/**
 * 喂一根已收盘的 K。
 *
 * 返回的 confirmed 至多一个：一次新 close **最多确认一个节点**，相反方向的节点
 * 必须等下一根 K（§6.1）。这条限制在实现上是自然的——确认高点的同时会把
 * running min 初始化成当前 close，同一根不可能再确认低点——但仍显式断言。
 */
export function stepPivot(state: PivotState, bar: Candle, reversal: number): StepResult {
  if (!isRealBar(bar)) {
    // 缺口（unknown）会重置未确认节点：跨过一段看不见的行情之后，
    // 手上那个「running 极值」已经没有意义了。synthetic 则只是跳过，不重置。
    if (bar.quality === 'unknown') {
      return { state: { ...state, initialized: false, origin: null, lastBarTs: null }, confirmed: null };
    }
    return { state, confirmed: null };
  }
  const close = bar.close;
  if (!state.initialized) {
    // §6.2：首次完整采集后，以第一个真实 close 初始化低点，方向为上行。
    return {
      state: {
        mode: 'up', extreme: close, extremeTs: bar.closeTs, pivots: state.pivots,
        initialized: true, origin: { price: close, ts: bar.closeTs }, lastBarTs: bar.closeTs,
      },
      confirmed: null,
    };
  }

  const s = { ...state, lastBarTs: bar.closeTs };
  if (s.mode === 'up') {
    // 相同价格取最早极值，所以这里是严格大于。
    if (close > s.extreme) { s.extreme = close; s.extremeTs = bar.closeTs; return { state: s, confirmed: null }; }
    if (s.extreme > 0 && (s.extreme - close) / s.extreme >= reversal) {
      const p: Pivot = { kind: 'high', price: s.extreme, extremeTs: s.extremeTs, confirmedAt: bar.closeTs };
      return {
        state: { ...s, mode: 'down', extreme: close, extremeTs: bar.closeTs, pivots: [...s.pivots, p] },
        confirmed: p,
      };
    }
    return { state: s, confirmed: null };
  }

  if (close < s.extreme) { s.extreme = close; s.extremeTs = bar.closeTs; return { state: s, confirmed: null }; }
  if (s.extreme > 0 && (close - s.extreme) / s.extreme >= reversal) {
    const p: Pivot = { kind: 'low', price: s.extreme, extremeTs: s.extremeTs, confirmedAt: bar.closeTs };
    return {
      state: { ...s, mode: 'up', extreme: close, extremeTs: bar.closeTs, pivots: [...s.pivots, p] },
      confirmed: p,
    };
  }
  return { state: s, confirmed: null };
}

/** 按顺序跑完一段 K 线，返回所有已确认节点。回放与实时必须得到同样结果。 */
export function detectPivots(bars: Candle[], reversal: number): { pivots: Pivot[]; state: PivotState } {
  let state = emptyPivotState();
  for (const b of bars) state = stepPivot(state, b, reversal).state;
  return { pivots: state.pivots, state };
}

// ── 统计工具（箱体计算用；固定口径，避免两个模块算出不同的数） ──────────────

/**
 * 分位数，固定 linear interpolation：排序后取索引 `(n-1)*q`，两侧线性插值。
 * 换一种 quantile 定义会让箱体上下沿整体位移，必须写死。
 */
export function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const v = [...values].sort((a, b) => a - b);
  const idx = (v.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return v[lo]!;
  return v[lo]! + (v[hi]! - v[lo]!) * (idx - lo);
}

export function median(values: number[]): number { return quantile(values, 0.5); }

/**
 * OLS 斜率。自变量必须是**真实经过小时**，不能用样本序号代替——
 * 缺了几根 K 的时候两者会给出完全不同的漂移结论。
 */
export function olsSlopePerHour(points: { hours: number; value: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p.hours, 0) / n;
  const my = points.reduce((s, p) => s + p.value, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.hours - mx) * (p.value - my); den += (p.hours - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}
