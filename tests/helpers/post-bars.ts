/**
 * 形态测试用的合成 K 线 fixture。
 *
 * 明确标注：这是**合成数据**，不是实测行情。设计文档 §2.3 允许用真实历史或
 * 明确标注的合成 fixture 验证规则，但不允许从截图 OCR 出伪造 K 线冒充真实数据。
 * 这些序列的唯一用途是让每条规则的边界可以手算复核。
 */
import type { Candle, Quality, Timeframe } from '../../src/post/types.js';

export const TF15 = 900;
export const TF1 = 60;
export const BASE_TS = 1_800_000_000_000;

export interface BarSpec {
  close: number;
  /** 默认真实成交桶。synthetic 平线与 unknown 缺口桶都不是形态证据。 */
  kind?: 'real' | 'synthetic' | 'unknown';
  swaps?: number;
  high?: number;
  low?: number;
  fdv?: number | null;
}

/** 按固定周期把一串收盘价铺成连续 K 线；openTs 从 BASE_TS 开始。 */
export function bars(specs: (number | BarSpec)[], tfSec: Timeframe, startTs = BASE_TS): Candle[] {
  return specs.map((raw, i) => {
    const s: BarSpec = typeof raw === 'number' ? { close: raw } : raw;
    const kind = s.kind ?? 'real';
    const openTs = startTs + i * tfSec * 1000;
    const closeTs = openTs + tfSec * 1000;
    const quality: Quality = kind === 'unknown' ? 'unknown' : 'complete';
    return {
      chainId: 4663, ca: '0xca', poolId: '0xpool', seriesId: 'S-test',
      timeframeSec: tfSec, openTs, closeTs, availableAt: closeTs,
      open: s.close, high: s.high ?? s.close, low: s.low ?? s.close, close: kind === 'unknown' ? (null as any) : s.close,
      volumeUsd: kind === 'unknown' ? null : kind === 'synthetic' ? 0 : 1000,
      swaps: kind === 'real' ? (s.swaps ?? 5) : 0,
      fdvCloseUsd: s.fdv ?? null,
      closed: true, synthetic: kind === 'synthetic', quality,
      source: 'fixture', quoteQuality: 'historical', revision: 1,
    };
  });
}

/** 线性插值出 n 根从 from 到 to 的 K，用来搭第一波拉升/回落。 */
export function ramp(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + (to - from) * (i / Math.max(n - 1, 1)));
}

/** 在 [lo, hi] 之间来回震荡 n 根，period 根一个来回。用来搭箱体。 */
export function oscillate(lo: number, hi: number, n: number, period = 12): number[] {
  return Array.from({ length: n }, (_, i) => {
    const phase = (i % period) / period;
    return phase < 0.5 ? lo + (hi - lo) * (phase * 2) : hi - (hi - lo) * ((phase - 0.5) * 2);
  });
}
