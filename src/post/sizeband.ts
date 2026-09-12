/**
 * 3–5M 量级过滤（设计文档 §2.2）。
 *
 * 帖子只写了「交易量维持 3–5m」，没写统计周期，图里的轴又是市值。这是**歧义**，
 * 所以三种互斥口径都要实现，卡片必须写清当前用的是哪一种，上线报告至少比较
 * `fdv_proxy` 与 `off`。**禁止**把同一个数值同时当市值和成交额用，
 * 也不能挑回测收益最好的那种之后声称还原了作者原意。
 */
import type { Candle, Evaluation } from './types.js';
import { pass, fail, unknown as unk } from './types.js';
import { isRealBar, median } from './patterns/pivots.js';

export type SizeBandMode = 'fdv_proxy' | 'volume_usd' | 'off';

export interface SizeBandConfig {
  mode: SizeBandMode;
  min_usd: number;
  max_usd: number;
  volume_window_hours: number | null;
  volume_in_band_ratio_min: number;
}

export interface SizeBandResult {
  evaluation: Evaluation;
  /** 卡片上那一行「3–5M 口径」的原文。 */
  label: string;
  observed: number | null;
}

/**
 * @param boxBars   箱体期间的 K 线（fdv_proxy 用它的 FDV 中位数）
 * @param hourlyVolumes  箱体内每小时末的滚动成交额（volume_usd 用）；
 *                       完整覆盖不足窗口时传 null，结果必须是 unknown。
 */
export function evaluateSizeBand(
  cfg: SizeBandConfig,
  boxBars: Candle[],
  hourlyVolumes: number[] | null,
  asOf: number,
): SizeBandResult {
  const range = `[$${(cfg.min_usd / 1e6).toFixed(0)}M, $${(cfg.max_usd / 1e6).toFixed(0)}M]`;

  if (cfg.mode === 'off') {
    return {
      label: '量级限制未启用',
      observed: null,
      evaluation: pass('size_band', 'off', 'off',
        '量级限制未启用（mode=off），用于比较策略对 3–5M 这个歧义的敏感性', asOf),
    };
  }

  if (cfg.mode === 'fdv_proxy') {
    const fdvs = boxBars.filter(isRealBar).map(b => b.fdvCloseUsd).filter((v): v is number => v !== null && v > 0);
    if (!fdvs.length) {
      return {
        label: '3–5M 口径：FDV 代理（暂定）· 无时点供应量，未知',
        observed: null,
        evaluation: unk('size_band', null, range,
          '箱体期间没有任何时点供应量证据，FDV 未知，3–5M 条件无法判定', asOf),
      };
    }
    const mid = median(fdvs);
    const ok = mid >= cfg.min_usd && mid <= cfg.max_usd;
    return {
      label: '3–5M 口径：FDV 代理（暂定）',
      observed: mid,
      evaluation: ok
        ? pass('size_band', Math.round(mid), range,
            `箱体中位 FDV $${(mid / 1e6).toFixed(2)}M 落在 ${range}；这是对图文的推断口径，不是作者确认的原意`, asOf)
        : fail('size_band', Math.round(mid), range,
            `箱体中位 FDV $${(mid / 1e6).toFixed(2)}M 不在 ${range}`, asOf),
    };
  }

  // volume_usd：必须显式给窗口，且必须有完整覆盖
  if (cfg.volume_window_hours === null || !(cfg.volume_window_hours > 0)) {
    return {
      label: '3–5M 口径：滚动成交额（窗口未配置）',
      observed: null,
      evaluation: unk('size_band', null, range,
        'mode=volume_usd 但没有显式给 volume_window_hours；原文没写这个窗口，不能默认一个', asOf),
    };
  }
  if (!hourlyVolumes || !hourlyVolumes.length) {
    return {
      label: `3–5M 口径：滚动成交额 ${cfg.volume_window_hours}h（覆盖不足，未知）`,
      observed: null,
      evaluation: unk('size_band', null, range,
        `完整覆盖不足 ${cfg.volume_window_hours}h 窗口，滚动成交额无法计算`, asOf),
    };
  }
  const inBand = hourlyVolumes.filter(v => v >= cfg.min_usd && v <= cfg.max_usd).length;
  const ratio = inBand / hourlyVolumes.length;
  const ok = ratio >= cfg.volume_in_band_ratio_min;
  const mid = median(hourlyVolumes);
  return {
    label: `3–5M 口径：滚动成交额 ${cfg.volume_window_hours}h（实验值，非原文参数）`,
    observed: mid,
    evaluation: ok
      ? pass('size_band', { ratio: round(ratio), medianUsd: Math.round(mid) },
          { range, ratioMin: cfg.volume_in_band_ratio_min },
          `${(ratio * 100).toFixed(0)}% 的小时样本滚动成交额落在 ${range}`, asOf)
      : fail('size_band', { ratio: round(ratio), medianUsd: Math.round(mid) },
          { range, ratioMin: cfg.volume_in_band_ratio_min },
          `只有 ${(ratio * 100).toFixed(0)}% 的小时样本在 ${range}，低于 ${(cfg.volume_in_band_ratio_min * 100).toFixed(0)}%`, asOf),
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;
