/**
 * 策略 C：1–2M 关口回踩后重新新高 MILLION_RECLAIM（设计文档 §7.2）。
 *
 * 独立于 B 的增强分支。用 1m close + **当时的 FDV**；没有价格历史或供应量时点
 * 就不触发——不能拿今天的供应量倒算过去的市值再说「它当时到过 1M」。
 *
 * 确认必须 price 与 FDV **同时**创新高：只有 FDV 新高、价格没有新高，
 * 说明是供应量变了，不是买盘推上去的。
 */
import type { Candle, Evaluation } from '../types.js';
import { pass, fail, unknown as unk } from '../types.js';
import { isRealBar } from './pivots.js';

const MIN = 60_000;

export type MillionPhase =
  | 'BELOW_GATE' | 'AT_GATE' | 'PULLBACK' | 'CONFIRMED'
  | 'GATE_SKIPPED' | 'GATE_EXPIRED' | 'DEEP_DUMP' | 'RECOVERY_TIMEOUT' | 'INVALIDATED' | 'NO_FDV';

export interface MillionConfig {
  gate_min_usd: number;
  gate_max_usd: number;
  gate_to_dip_max_minutes: number;
  dip_min: number;
  dip_max: number;
  recovery_max_minutes: number;
  new_high_buffer: number;
  confirm_bars: number;
}

export interface MillionEvent {
  type: 'MILLION_RECLAIM_CONFIRMED' | 'MILLION_RECLAIM_INVALIDATED';
  barCloseTs: number;
  reason: string;
  snapshot: Record<string, unknown>;
}

export interface MillionResult {
  phase: MillionPhase;
  reason: string;
  gateEnteredAt: number | null;
  peakPrice: number | null;
  peakFdv: number | null;
  dipLow: number | null;
  confirmedAt: number | null;
  evaluations: Evaluation[];
  events: MillionEvent[];
  lastBarTs: number | null;
}

export function runMillionReclaim(bars: Candle[], cfg: MillionConfig): MillionResult {
  const evaluations: Evaluation[] = [];
  const events: MillionEvent[] = [];

  let phase: MillionPhase = 'BELOW_GATE';
  let reason = '尚未从 1M 以下进入 1–2M 关口';
  let gateEnteredAt: number | null = null;
  let peakPrice: number | null = null, peakFdv: number | null = null, peakTs: number | null = null;
  let dipLow: number | null = null, dipStartTs: number | null = null;
  let confirmedAt: number | null = null;
  let confirmRun = 0;
  let prevFdv: number | null = null;
  let lastBarTs: number | null = null;
  let sawFdv = false;

  const terminal = () => ['GATE_SKIPPED', 'GATE_EXPIRED', 'DEEP_DUMP', 'RECOVERY_TIMEOUT', 'INVALIDATED'].includes(phase);

  for (const bar of bars) {
    if (terminal()) break;
    if (!bar.closed || !isRealBar(bar)) continue;
    lastBarTs = bar.closeTs;
    const fdv = bar.fdvCloseUsd;
    if (fdv === null) {
      // 没有时点供应量 → FDV unknown → 本分支不触发，也不猜。
      evaluations.push(unk('million_reclaim.fdv', null, `[${cfg.gate_min_usd}, ${cfg.gate_max_usd}]`,
        '该桶没有时点供应量证据，FDV 未知，关口分支不触发', bar.closeTs));
      prevFdv = null;
      continue;
    }
    sawFdv = true;

    // ── 确认后的跟踪
    if (confirmedAt !== null) {
      if (bar.closeTs - confirmedAt <= 30 * MIN && dipLow !== null && bar.close < dipLow) {
        phase = 'INVALIDATED';
        reason = '触发后 30 分钟内收盘跌回本次回调低点之下';
        events.push({ type: 'MILLION_RECLAIM_INVALIDATED', barCloseTs: bar.closeTs, reason, snapshot: { close: bar.close, dipLow } });
        break;
      }
      continue;
    }

    // ── 1. 进入关口
    if (gateEnteredAt === null) {
      const below = prevFdv !== null && prevFdv < cfg.gate_min_usd;
      if (below && fdv > cfg.gate_max_usd) {
        phase = 'GATE_SKIPPED';
        reason = `FDV 从 $${fmt(prevFdv!)} 一根跳到 $${fmt(fdv)}，跳过了 1–2M 关口`;
        evaluations.push(fail('million_reclaim.gate', { prevFdv, fdv }, `[${cfg.gate_min_usd}, ${cfg.gate_max_usd}]`,
          'gate_skipped：首版不猜测中间是否已完成关口', bar.closeTs));
        break;
      }
      if (below && fdv >= cfg.gate_min_usd && fdv <= cfg.gate_max_usd) {
        gateEnteredAt = bar.closeTs;
        peakPrice = bar.close; peakFdv = fdv; peakTs = bar.closeTs;
        phase = 'AT_GATE';
        reason = `首次从 1M 以下进入关口（FDV $${fmt(fdv)}）`;
        evaluations.push(pass('million_reclaim.gate', round(fdv), `[${cfg.gate_min_usd}, ${cfg.gate_max_usd}]`, reason, bar.closeTs));
      }
      prevFdv = fdv;
      continue;
    }
    prevFdv = fdv;

    // ── 2. 关口内维护峰值，等第一次 ≥15% 的价格回撤
    if (phase === 'AT_GATE') {
      if (peakPrice === null || bar.close > peakPrice) { peakPrice = bar.close; peakFdv = fdv; peakTs = bar.closeTs; }
      const drop = peakPrice > 0 ? (peakPrice - bar.close) / peakPrice : 0;
      if (drop >= cfg.dip_min) {
        phase = 'PULLBACK';
        dipLow = bar.close;
        dipStartTs = bar.closeTs;
        reason = `进入关口后回撤 ${pct(drop)}，峰值冻结（价 $${peakPrice.toPrecision(4)} / FDV $${fmt(peakFdv!)}）`;
        continue;
      }
      if (bar.closeTs - gateEnteredAt > cfg.gate_to_dip_max_minutes * MIN) {
        phase = 'GATE_EXPIRED';
        reason = `进入关口后 ${cfg.gate_to_dip_max_minutes} 分钟内没有出现 ≥${pct(cfg.dip_min)} 回撤`;
        evaluations.push(fail('million_reclaim.dip_timing', Math.round((bar.closeTs - gateEnteredAt) / MIN),
          cfg.gate_to_dip_max_minutes, reason, bar.closeTs));
        break;
      }
      continue;
    }

    // ── 3. 回撤中：限深、限时、等两根同时新高
    if (phase === 'PULLBACK') {
      if (dipLow === null || bar.close < dipLow) dipLow = bar.close;
      const depth = (peakPrice! - dipLow!) / peakPrice!;
      if (depth > cfg.dip_max) {
        phase = 'DEEP_DUMP';
        reason = `回撤 ${pct(depth)} 超过 ${pct(cfg.dip_max)}`;
        evaluations.push(fail('million_reclaim.dip_depth', round(depth), cfg.dip_max, reason, bar.closeTs));
        break;
      }
      if (bar.closeTs - dipStartTs! > cfg.recovery_max_minutes * MIN) {
        phase = 'RECOVERY_TIMEOUT';
        reason = `回撤后 ${cfg.recovery_max_minutes} 分钟内没有完成「快速收复并新高」`;
        evaluations.push(fail('million_reclaim.recovery_time', Math.round((bar.closeTs - dipStartTs!) / MIN),
          cfg.recovery_max_minutes, reason, bar.closeTs));
        break;
      }
      const priceNewHigh = bar.close > peakPrice! * (1 + cfg.new_high_buffer);
      const fdvNewHigh = fdv > peakFdv! * (1 + cfg.new_high_buffer);
      if (priceNewHigh && fdvNewHigh) {
        confirmRun++;
        if (confirmRun >= cfg.confirm_bars) {
          confirmedAt = bar.closeTs;
          phase = 'CONFIRMED';
          reason = `回踩后连续 ${cfg.confirm_bars} 根 1m 收盘同时创价格与 FDV 新高`;
          events.push({
            type: 'MILLION_RECLAIM_CONFIRMED', barCloseTs: bar.closeTs, reason,
            snapshot: {
              gateEnteredAt, peakPrice, peakFdv, peakTs, dipLow, dipStartTs,
              close: bar.close, fdv,
              note: '1–2M 是此前经过的关口，不要求确认时 FDV 仍 ≤2M',
            },
          });
          evaluations.push(pass('million_reclaim.reclaim',
            { price: round(bar.close / peakPrice!), fdv: round(fdv / peakFdv!) },
            1 + cfg.new_high_buffer, reason, bar.closeTs));
        }
      } else {
        if (priceNewHigh && !fdvNewHigh) {
          evaluations.push(fail('million_reclaim.supply', { priceNewHigh, fdvNewHigh }, 'both',
            '只有价格新高、FDV 没有新高，说明供应量变化，不算收复新高', bar.closeTs));
        }
        confirmRun = 0;
      }
    }
  }

  if (!sawFdv && phase === 'BELOW_GATE') {
    phase = 'NO_FDV';
    reason = '整段没有任何可用的时点 FDV，关口分支无法判定';
  }

  return { phase, reason, gateEnteredAt, peakPrice, peakFdv, dipLow, confirmedAt, evaluations, events, lastBarTs };
}

const round = (n: number) => Math.round(n * 10000) / 10000;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}K`);
