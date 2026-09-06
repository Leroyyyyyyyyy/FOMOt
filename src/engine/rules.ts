import type { Rules } from '../config.js';
import type { Market } from '../chain/marketdata.js';
import type { Enriched } from './enrich.js';

type Filters = Rules['filters'];
export const inRange = (v: number, r: { min?: number; max?: number } | undefined) =>
  !r || ((r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max));

/**
 * 门的结果有**三态**，不是两态。
 *
 * 以前 `missing` 被当成 `pass` 返回 null：复核时 FOMO 刷新失败拿回空 enrichment，
 * 在 `skip_when_unavailable=true` 下规则「放行」，任务随即被标成 completed——
 * 于是「刷新失败一定重试」根本不成立，缺数据被记成了成功。
 *
 * 现在把「规则判定不通过」和「判定所需数据没采到」彻底分开：
 *   - reject  → 这个币不该推，撤回；
 *   - missing → 还不知道该不该推，重试，**不得**标完成，**也不得**撤回。
 */
export type Gate =
  | { kind: 'pass' }
  | { kind: 'reject'; reason: string }
  | { kind: 'missing'; reason: string };

const PASS: Gate = { kind: 'pass' };
const reject = (reason: string): Gate => ({ kind: 'reject', reason });
const missing = (reason: string): Gate => ({ kind: 'missing', reason });

export function chainRejection(m: Pick<Market, 'marketCapUsd' | 'volume5m' | 'volume1h'>, f: Filters): string | null {
  if (!inRange(m.marketCapUsd, f.market_cap_usd)) return '市值不在区间';
  if (!inRange(m.volume5m, f.volume_5m_usd)) return '5m 成交量不在区间';
  if (!inRange(m.volume1h, f.volume_1h_usd)) return '1h 成交量不在区间';
  return null;
}

export function fomoGate(total: number, e: Enriched, f: Filters): Gate {
  if (!e.available) {
    return f.skip_when_unavailable === false
      ? reject('FOMO 数据不可用')
      : missing('FOMO 数据未采到');
  }
  const fomo = e.fomoHolders ?? 0;
  if (!inRange(fomo, f.fomo_holders)) return reject(`Fomo 持币人 ${fomo} 不在区间`);
  const ratio = total > 0 ? fomo / total : 0;
  if (!inRange(ratio, f.fomo_holder_ratio)) return reject(`Fomo 占比 ${(ratio * 100).toFixed(1)}% 不在区间`);
  if (!e.leaderboardAvailable) {
    return f.skip_when_unavailable === false
      ? reject('FOMO 盈利榜不可用')
      : missing('FOMO 盈利榜未采到');
  }
  if (!inRange(e.leaders.length, f.fomo_leaderboard_holders)) return reject(`盈利榜持有人 ${e.leaders.length} 不在区间`);
  return PASS;
}

export function initialGate(total: number | null, e: Enriched, f: Filters): Gate {
  if (total === null) return missing('拿不到持币快照');
  if (!inRange(total, f.holders_total)) return reject(`全链持币人 ${total} 不在区间`);
  return f.fomo_gate_stage === 'initial' ? fomoGate(total, e, f) : PASS;
}

export function recheckGate(total: number | null, e: Enriched, f: Filters): Gate {
  // 持币快照是复核的**必需**数据：拿不到就不知道该不该撤，只能重试。
  if (total === null) return missing('复核拿不到持币快照');
  if (f.fomo_gate_stage !== 'recheck') return PASS;
  return fomoGate(total, e, f);
}

/** 诊断脚本用的旧签名：只关心「是否被拒」，missing 不算拒。 */
export const initialRejection = (t: number | null, e: Enriched, f: Filters): string | null => {
  const g = initialGate(t, e, f);
  return g.kind === 'reject' ? g.reason : null;
};
export const recheckRejection = (t: number | null, e: Enriched, f: Filters): string | null => {
  const g = recheckGate(t, e, f);
  return g.kind === 'reject' ? g.reason : null;
};
export const fomoRejection = (t: number, e: Enriched, f: Filters): string | null => {
  const g = fomoGate(t, e, f);
  return g.kind === 'reject' ? g.reason : null;
};
