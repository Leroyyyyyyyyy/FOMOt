/**
 * 一个候选的完整评估：K 线 → 形态 → 叙事/量级门 → 渲染 → 信号事务（§13 阶段 2/3）。
 *
 * 这一层只负责「组装」，判定逻辑全部在 patterns/* 与 narrative.ts 里，
 * 这样回放脚本可以用同一套函数、只换时钟与 runId。
 */
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { log } from '../logger.js';
import type { PostConfig } from './config.js';
import { loadCandles, realBarRatio } from './market/candles.js';
import { runSecondLeg, type SecondLegResult } from './patterns/second-leg.js';
import { runNewPullback, type NewPullbackResult } from './patterns/new-pullback.js';
import { runMillionReclaim, type MillionResult } from './patterns/million-reclaim.js';
import { rsiFromCandles, detectOverheat } from './patterns/rsi.js';
import { evaluateSizeBand } from './sizeband.js';
import { decideNarrative, latestReport } from './narrative.js';
import { persistSignal, recordEvaluations, signalIdFor } from './signals.js';
import { messageRef } from './outbox.js';
import { renderSecondLeg, renderNewPullback, renderRiskCard, renderFollowUp, linkButtons, type CardContext } from '../notify/post-render.js';
import type { Evaluation, SignalEventType, Timeframe } from './types.js';
import type { NotifyMode } from '../notify/notifier.js';

export interface EvaluationContext {
  cfg: PostConfig;
  configHash: string;
  chainId: number;
  ca: string;
  symbol: string | null;
  seriesId: string;
  firstTradeTs: number | null;
  ageQuality: 'verified' | 'age_unverified' | 'unknown';
  asOf: number;
  watermarkTs: number;
  mode: NotifyMode;
  runId: string;
  /** 演练/测试用：跳过真正的入队，只返回会发什么。 */
  dryRun?: boolean;
}

export interface EvaluationOutcome {
  secondLeg: SecondLegResult | null;
  newPullback: NewPullbackResult | null;
  million: MillionResult | null;
  evaluations: Evaluation[];
  signals: { signalId: string; eventType: SignalEventType; text: string; created: boolean }[];
  skipped: string[];
}

const H = 3600_000;
const DESTINATION = 'tg';

export const episodeIdFor = (chainId: number, ca: string, strategy: string, anchorId: string, version: number, runId: string): string =>
  `EP-${createHash('sha256').update([chainId, ca.toLowerCase(), strategy, anchorId, version, runId].join('|')).digest('hex').slice(0, 14)}`;

const upsertEpisode = db.prepare(
  `INSERT INTO post_episodes (episode_id, chain_id, ca, strategy, anchor_id, version, series_id, state,
     state_since, frozen, clocks, last_processed_bar, config_hash, config_snapshot, terminal, run_id, created_at, updated_at)
   VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(episode_id) DO UPDATE SET state=excluded.state, state_since=excluded.state_since,
     frozen=excluded.frozen, clocks=excluded.clocks, last_processed_bar=excluded.last_processed_bar,
     terminal=excluded.terminal, updated_at=excluded.updated_at, revision=post_episodes.revision+1`,
);

function saveEpisode(ctx: EvaluationContext, strategy: string, anchorId: string, state: string,
                     frozen: unknown, clocks: unknown, lastBar: number | null, terminal: boolean): string {
  const id = episodeIdFor(ctx.chainId, ctx.ca, strategy, anchorId, 1, ctx.runId);
  upsertEpisode.run(id, ctx.chainId, ctx.ca.toLowerCase(), strategy, anchorId, ctx.seriesId, state, ctx.asOf,
    JSON.stringify(frozen ?? null), JSON.stringify(clocks ?? null), lastBar, ctx.configHash,
    JSON.stringify({ hash: ctx.configHash }), terminal ? 1 : 0, ctx.runId, ctx.asOf, ctx.asOf);
  return id;
}

export function evaluateEpisodes(ctx: EvaluationContext): EvaluationOutcome {
  const out: EvaluationOutcome = {
    secondLeg: null, newPullback: null, million: null, evaluations: [], signals: [], skipped: [],
  };
  const cardCtx: CardContext = { timezone: ctx.cfg.render.timezone, locale: ctx.cfg.render.locale };

  // ── 二段（15m）
  if (ctx.cfg.second_leg.enabled) {
    const tf = ctx.cfg.second_leg.timeframe_seconds as Timeframe;
    const span = (ctx.cfg.second_leg.ready_max_hours + ctx.cfg.second_leg.first_leg_max_hours
      + ctx.cfg.second_leg.seed_box_hours + 24) * H;
    const bars = loadCandles(ctx.seriesId, tf, ctx.watermarkTs - span, ctx.watermarkTs + tf * 1000, { asOf: ctx.asOf });
    if (bars.length) {
      const r = runSecondLeg(bars, ctx.cfg.second_leg as any);
      out.secondLeg = r;
      out.evaluations.push(...r.evaluations);
      emitSecondLeg(ctx, r, bars, cardCtx, out);
    } else {
      out.skipped.push('second_leg: 还没有可用的 15m 闭合 K（history_warming）');
    }
  }

  // ── 新币 / 百万关口（1m）
  const npCfg = ctx.cfg.new_pullback;
  if (npCfg.enabled && ctx.firstTradeTs !== null) {
    const tf = npCfg.timeframe_seconds as Timeframe;
    const bars = loadCandles(ctx.seriesId, tf, ctx.firstTradeTs - tf * 1000,
      ctx.watermarkTs + tf * 1000, { asOf: ctx.asOf });
    if (bars.length) {
      const r = runNewPullback(bars, npCfg as any, { firstTradeTs: ctx.firstTradeTs, ageQuality: ctx.ageQuality });
      out.newPullback = r;
      out.evaluations.push(...r.evaluations);

      let m: MillionResult | null = null;
      if (ctx.cfg.million_reclaim.enabled && ctx.ageQuality === 'verified') {
        m = runMillionReclaim(bars, ctx.cfg.million_reclaim as any);
        out.million = m;
        out.evaluations.push(...m.evaluations);
      }
      emitLaunch(ctx, r, m, bars, cardCtx, out);
    } else {
      out.skipped.push('new_pullback: 还没有可用的 1m 闭合 K');
    }
  }

  // 无论有没有信号，evaluation 都要落库——要能回答「为什么没推」。
  recordEvaluations(out.evaluations, {
    episodeId: null, chainId: ctx.chainId, ca: ctx.ca, strategy: 'post_v1', runId: ctx.runId,
  });
  return out;
}

// ── 二段事件 → 信号 ────────────────────────────────────────────────────────

function emitSecondLeg(ctx: EvaluationContext, r: SecondLegResult, bars: any[], cardCtx: CardContext, out: EvaluationOutcome): void {
  if (!r.firstLeg || !r.events.length) return;
  const anchorId = `firstLegHigh:${r.firstLeg.highTs}`;
  const terminal = ['INVALIDATED', 'EXPIRED', 'RANGE_REJECTED'].includes(r.phase);
  const episodeId = saveEpisode(ctx, 'second_leg', anchorId, r.phase, r.box, {
    rangeStartTs: r.rangeStartTs, readyAt: r.readyAt, breakoutAt: r.breakoutAt,
  }, r.lastBarTs, terminal);

  const boxBars = r.rangeStartTs === null ? [] : bars.filter((b: any) => b.closeTs > r.rangeStartTs!);
  const sizeBand = evaluateSizeBand(ctx.cfg.size_band as any, boxBars, null, ctx.asOf);
  out.evaluations.push(sizeBand.evaluation);

  const report = latestReport(ctx.chainId, ctx.ca, ctx.asOf);
  const narrative = decideNarrative(report, ctx.cfg.narrative as any, ctx.asOf);
  out.evaluations.push(...narrative.evaluations);

  const rsi = safeRsi(ctx, ctx.cfg.second_leg.timeframe_seconds as Timeframe);

  for (const ev of r.events) {
    const gateOk = ev.type !== 'SECOND_LEG_READY' ||
      (sizeBand.evaluation.result === 'pass' && narrative.allowsStandardSignal);
    if (!gateOk) {
      out.skipped.push(`SECOND_LEG_READY 未发：${sizeBand.evaluation.result !== 'pass'
        ? sizeBand.evaluation.reason : narrative.evaluations.find(e => e.result !== 'pass')?.reason ?? '叙事门未通过'}`);
      continue;
    }

    const isReady = ev.type === 'SECOND_LEG_READY';
    const ref = messageRef(groupKeyOf(ctx, 'second_leg', anchorId), DESTINATION, ctx.mode, ctx.runId);
    const snap: any = ev.snapshot;
    const text = isReady || ev.type === 'SECOND_LEG_INVALIDATED'
      ? renderSecondLeg({
          symbol: ctx.symbol, ca: ctx.ca,
          priceUsd: snap.close ?? bars[bars.length - 1]?.close ?? 0,
          fdvUsd: bars[bars.length - 1]?.fdvCloseUsd ?? null,
          boxLower: r.box?.lower ?? 0, boxUpper: r.box?.upper ?? 0,
          rangeAgeHours: r.rangeAgeHours ?? 0,
          firstLegMultiple: r.firstLeg.multiple, maxDrawdown: r.firstLeg.maxDrawdown,
          insideRatio: r.insideRatio ?? 0, zoneVisits: r.zoneVisits,
          timeframeLabel: `${ctx.cfg.second_leg.timeframe_seconds / 60}m`,
          sizeBandLabel: sizeBand.label,
          narrativeSummary: report?.summary ?? null,
          narrativeNovelty: noveltyLabel(report?.novelty),
          narrativeClaims: report?.claims.length ?? 0,
          invalidBelow: (r.box?.lower ?? 0) * (1 - ctx.cfg.second_leg.soft_break_max),
          expiresAt: (r.rangeStartTs ?? 0) + ctx.cfg.second_leg.ready_max_hours * H,
          rsi: rsi.value, rsiTimeframe: `${ctx.cfg.second_leg.timeframe_seconds / 60}m`,
          dataQuality: dataQualityLabel(bars),
          quoteNote: quoteNote(bars), source: bars[0]?.source ?? 'chain',
          signalId: signalIdFor(episodeId, ev.type, 1, ctx.runId),
          configHash: ctx.configHash, marketAsOf: ctx.watermarkTs,
          wickRisk: wickBelow(boxBars, r.box?.lower ?? 0),
          invalidated: ev.type === 'SECOND_LEG_INVALIDATED' ? { at: ev.barCloseTs, reason: ev.reason } : null,
        }, cardCtx)
      : renderFollowUp({
          symbol: ctx.symbol, ca: ctx.ca,
          relatedSignalId: signalIdFor(episodeId, 'SECOND_LEG_READY', 1, ctx.runId),
          headline: headlineOf(ev.type), reason: ev.reason, at: ev.barCloseTs,
        }, cardCtx);

    // READY 发主卡；其余事件在原卡已存在时编辑，否则只发关联简讯。
    const op = !isReady && ref?.messageId ? 'edit' : 'send';
    push(ctx, out, {
      episodeId, strategy: 'second_leg', eventType: ev.type as SignalEventType,
      groupKey: groupKeyOf(ctx, 'second_leg', anchorId),
      barCloseTs: ev.barCloseTs, snapshot: ev.snapshot, text,
      op, messageId: op === 'edit' ? ref!.messageId : null,
      revision: op === 'edit' ? (ref!.lastRevision + 1) : 1,
      quality: dataQualityLabel(bars),
      evaluations: [...r.evaluations, sizeBand.evaluation, ...narrative.evaluations],
    });
  }
}

// ── 新币 / 百万 → 信号 ─────────────────────────────────────────────────────

function emitLaunch(ctx: EvaluationContext, r: NewPullbackResult, m: MillionResult | null,
                    bars: any[], cardCtx: CardContext, out: EvaluationOutcome): void {
  const events = [...r.events, ...(m?.events ?? [])];
  if (!events.length) return;

  const anchorId = `launch:${ctx.firstTradeTs}`;
  const terminal = ['DEEP_DUMP', 'EXTENDED_REBOUND', 'TIMED_OUT', 'NO_IMPULSE', 'INVALIDATED'].includes(r.phase);
  const episodeId = saveEpisode(ctx, 'new_pullback', anchorId, r.phase, { cycles: r.cycles }, {
    confirmedAt: r.confirmedAt, millionConfirmedAt: m?.confirmedAt ?? null,
  }, r.lastBarTs, terminal);

  const report = latestReport(ctx.chainId, ctx.ca, ctx.asOf);
  const narrative = decideNarrative(report, ctx.cfg.narrative as any, ctx.asOf);
  out.evaluations.push(...narrative.evaluations);

  const confirmedNp = r.events.find(e => e.type === 'NEW_PULLBACK_CONFIRMED');
  const confirmedMr = m?.events.find(e => e.type === 'MILLION_RECLAIM_CONFIRMED');

  // 同一 token 同一根桶里 B 与 C 同时命中 → 合成一个事件组、一张消息、两条理由。
  const sameBar = confirmedNp && confirmedMr && confirmedNp.barCloseTs === confirmedMr.barCloseTs;
  const groupKey = groupKeyOf(ctx, 'launch', anchorId);

  if (confirmedNp) {
    if (!narrative.allowsStandardSignal && !narrative.speculativeOnly) {
      out.skipped.push(`NEW_PULLBACK_CONFIRMED 未发：${narrative.evaluations.find(e => e.result !== 'pass')?.reason ?? '叙事门未通过'}`);
    } else {
      const c1 = r.cycles[0]!, c2 = r.cycles[1]!;
      const text = renderNewPullback({
        symbol: ctx.symbol, ca: ctx.ca,
        ageLabel: ageLabel(ctx.firstTradeTs, confirmedNp.barCloseTs),
        timeframeLabel: `${ctx.cfg.new_pullback.timeframe_seconds / 60}m`,
        cycle1: { dip: c1.dipDepth, recovered: c1.recoveredFraction },
        cycle2: { dip: c2.dipDepth, recovered: c2.recoveredFraction },
        d1: c1.low, d2: c2.low,
        distanceFromSecondLow: r.distanceFromSecondLow ?? 0,
        millionReclaim: !!sameBar,
        narrativeSummary: report?.summary ?? null,
        narrativeNovelty: noveltyLabel(report?.novelty),
        speculativeOnly: narrative.speculativeOnly,
        invalidBelow: c2.low * (1 - ctx.cfg.new_pullback.invalid_below_second_low),
        confirmedAt: confirmedNp.barCloseTs, sentAt: ctx.asOf,
        signalId: signalIdFor(episodeId, 'NEW_PULLBACK_CONFIRMED', 1, ctx.runId),
        configHash: ctx.configHash, dataQuality: dataQualityLabel(bars),
      }, cardCtx);
      push(ctx, out, {
        episodeId, strategy: 'new_pullback',
        eventType: narrative.speculativeOnly ? 'SPECULATIVE_WATCH' : 'NEW_PULLBACK_CONFIRMED',
        groupKey, barCloseTs: confirmedNp.barCloseTs, snapshot: {
          ...confirmedNp.snapshot,
          millionReclaim: sameBar ? confirmedMr!.snapshot : null,
          reasons: sameBar ? [confirmedNp.reason, confirmedMr!.reason] : [confirmedNp.reason],
        },
        text, op: 'send', messageId: null, revision: 1,
        quality: dataQualityLabel(bars),
        evaluations: [...r.evaluations, ...narrative.evaluations],
      });
    }
  }

  // 未与 B 同桶命中的百万关口单独发；同桶的已经合并进上面那张卡。
  if (confirmedMr && !sameBar && narrative.allowsStandardSignal) {
    push(ctx, out, {
      episodeId, strategy: 'million_reclaim', eventType: 'MILLION_RECLAIM_CONFIRMED',
      groupKey, barCloseTs: confirmedMr.barCloseTs, snapshot: confirmedMr.snapshot,
      text: renderFollowUp({
        symbol: ctx.symbol, ca: ctx.ca,
        relatedSignalId: signalIdFor(episodeId, 'NEW_PULLBACK_CONFIRMED', 1, ctx.runId),
        headline: '🟢 1–2M 关口回踩后创新高', reason: confirmedMr.reason, at: confirmedMr.barCloseTs,
      }, cardCtx),
      op: 'send', messageId: null, revision: 1,
      quality: dataQualityLabel(bars),
      evaluations: m?.evaluations ?? [],
    });
  }

  // 风险类事件（第三跌、结构失效、关口失效）
  const ref = messageRef(groupKey, DESTINATION, ctx.mode, ctx.runId);
  for (const ev of events) {
    if (ev.type === 'NEW_PULLBACK_CONFIRMED' || ev.type === 'MILLION_RECLAIM_CONFIRMED') continue;
    push(ctx, out, {
      episodeId, strategy: 'new_pullback', eventType: ev.type as SignalEventType,
      groupKey, barCloseTs: ev.barCloseTs, snapshot: ev.snapshot,
      text: renderFollowUp({
        symbol: ctx.symbol, ca: ctx.ca,
        relatedSignalId: signalIdFor(episodeId, 'NEW_PULLBACK_CONFIRMED', 1, ctx.runId),
        headline: headlineOf(ev.type as SignalEventType), reason: ev.reason, at: ev.barCloseTs,
      }, cardCtx),
      op: 'send', messageId: null, revision: 1,
      quality: dataQualityLabel(bars),
      evaluations: [],
    });
  }

  // RSI 过热：只对已推送/仍在跟踪期的代币发
  if (ctx.cfg.rsi.enabled && r.confirmedAt !== null) {
    const rsi = safeRsi(ctx, ctx.cfg.new_pullback.timeframe_seconds as Timeframe);
    out.evaluations.push(...rsi.evaluations);
    for (const ev of rsi.events) {
      if (ev.barCloseTs < r.confirmedAt) continue;
      if (ev.barCloseTs > r.confirmedAt + ctx.cfg.notifications.followup_hours * H) continue;
      push(ctx, out, {
        episodeId, strategy: 'rsi', eventType: 'RSI_OVERHEAT',
        groupKey, barCloseTs: ev.barCloseTs, snapshot: { rsi: ev.rsi, smoothed: ev.smoothed },
        text: renderRiskCard({
          symbol: ctx.symbol, ca: ctx.ca,
          relatedSignalId: signalIdFor(episodeId, 'NEW_PULLBACK_CONFIRMED', 1, ctx.runId),
          rsi: ev.rsi, rsiTimeframe: `${ctx.cfg.new_pullback.timeframe_seconds / 60}m`,
          rsiLength: ctx.cfg.rsi.length, firstObservation: ev.firstObservation,
          changeFromFirstSignal: changeFromFirstSignal(bars, r.confirmedAt),
          referenceEntry: referenceEntry(ctx, bars),
          exitFraction: ctx.cfg.notifications.reference_exit_fraction,
          marketAsOf: ctx.watermarkTs,
        }, cardCtx),
        op: 'send', messageId: null, revision: 1,
        quality: dataQualityLabel(bars),
        evaluations: rsi.evaluations,
      });
    }
  }
  void ref;
}

// ── 落库 ───────────────────────────────────────────────────────────────────

interface PushInput {
  episodeId: string; strategy: string; eventType: SignalEventType;
  groupKey: string; barCloseTs: number; snapshot: Record<string, unknown>;
  text: string; op: 'send' | 'edit'; messageId: number | null; revision: number;
  quality: string; evaluations: Evaluation[];
}

function push(ctx: EvaluationContext, out: EvaluationOutcome, i: PushInput): void {
  const signalId = signalIdFor(i.episodeId, i.eventType, 1, ctx.runId);
  if (ctx.dryRun) {
    out.signals.push({ signalId, eventType: i.eventType, text: i.text, created: false });
    return;
  }
  try {
    const r = persistSignal({
      signal: {
        episodeId: i.episodeId, chainId: ctx.chainId, ca: ctx.ca, strategy: i.strategy,
        eventType: i.eventType, eventSeq: 1, groupKey: i.groupKey,
        detectedAt: i.barCloseTs, confirmedAt: i.barCloseTs, barCloseTs: i.barCloseTs,
        snapshot: i.snapshot, quality: i.quality, configHash: ctx.configHash,
        revision: i.revision, runId: ctx.runId,
      },
      evaluations: i.evaluations,
      payload: { text: i.text, markup: linkButtons(ctx.ca) },
      op: i.op, mode: ctx.mode, destination: DESTINATION,
      ttl: ctx.cfg.notifications as any,
      messageId: i.messageId,
      now: ctx.asOf,
    });
    out.signals.push({ signalId: r.signalId, eventType: i.eventType, text: i.text, created: r.created });
  } catch (err) {
    log.error({ ca: ctx.ca, eventType: i.eventType, err: String(err).slice(0, 160) }, 'post 信号落库失败');
  }
}

// ── 展示辅助 ───────────────────────────────────────────────────────────────

const groupKeyOf = (ctx: EvaluationContext, strategy: string, anchorId: string) => `${strategy}:${anchorId}`;

function headlineOf(t: SignalEventType): string {
  switch (t) {
    case 'SECOND_LEG_BREAKOUT': return '🚀 二段箱体突破确认';
    case 'SECOND_LEG_INVALIDATED': return '⚪️ 二段观察已失效';
    case 'SECOND_LEG_EXPIRED': return '⏳ 二段箱体已过期（未突破）';
    case 'BREAKOUT_FAILED': return '⚠️ 突破后跌回箱顶之下';
    case 'THIRD_DIP_RISK': return '⚠️ 确认后再次回撤（第三跌风险）';
    case 'STRUCTURE_INVALIDATED': return '⚪️ 结构失效';
    case 'MILLION_RECLAIM_INVALIDATED': return '⚪️ 关口收复失效';
    default: return '提示';
  }
}

const noveltyLabel = (n?: string) =>
  n === 'repeated' ? '本地覆盖范围内已见过同一概念'
    : n === 'new_in_index' ? '本地历史范围内未见重复'
    : n === 'insufficient_history' ? '同链题材索引覆盖不足，新鲜度未知'
    : '叙事待核验';

function dataQualityLabel(bars: any[]): string {
  if (!bars.length) return '无数据';
  if (bars.some((b: any) => b.quality === 'unknown')) return '有缺口（unknown 桶存在）';
  const ratio = realBarRatio(bars);
  return ratio >= 0.9 ? '完整' : `完整（真实成交桶 ${(ratio * 100).toFixed(0)}%，其余为 synthetic 平线）`;
}

function quoteNote(bars: any[]): string {
  const qualities = new Set(bars.map((b: any) => b.quoteQuality));
  if (qualities.has('peg_proxy')) return 'USDG 按 $1 代理（peg_proxy 假设）';
  if (qualities.has('missing')) return '部分区间缺历史报价';
  return '报价按事件时点匹配';
}

/** 影线曾跌破箱底但收盘没有——卡片必须提示插针风险。 */
function wickBelow(bars: any[], lower: number): boolean {
  return lower > 0 && bars.some((b: any) => b.quality !== 'unknown' && b.low !== null && b.low < lower && b.close >= lower);
}

function ageLabel(firstTradeTs: number | null, at: number): string {
  if (firstTradeTs === null) return '未知';
  const m = Math.max(0, Math.round((at - firstTradeTs) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
}

function safeRsi(ctx: EvaluationContext, tf: Timeframe) {
  const bars = loadCandles(ctx.seriesId, tf, ctx.watermarkTs - 200 * tf * 1000, ctx.watermarkTs + tf * 1000, { asOf: ctx.asOf });
  const series = rsiFromCandles(bars, ctx.cfg.rsi as any);
  const r = detectOverheat(series, ctx.cfg.rsi as any);
  const last = series.points[series.points.length - 1];
  return { value: last?.rsi ?? null, events: r.events, evaluations: r.evaluations };
}

/** 相对首次信号价的变化。**不是收益**——没有用户持仓成本就不能叫收益。 */
function changeFromFirstSignal(bars: any[], confirmedAt: number): number | null {
  const at = bars.find((b: any) => b.closeTs >= confirmedAt);
  const last = bars[bars.length - 1];
  if (!at?.close || !last?.close) return null;
  return (last.close - at.close) / at.close;
}

/** 人工导入的持仓参考价（可选）。只展示价格变化，不标净收益。 */
function referenceEntry(ctx: EvaluationContext, bars: any[]): { priceUsd: number; changePct: number } | null {
  const r = db.prepare(
    `SELECT price_usd FROM post_reference_entries WHERE chain_id=? AND ca=? ORDER BY entry_ts DESC LIMIT 1`,
  ).get(ctx.chainId, ctx.ca.toLowerCase()) as any;
  const last = bars[bars.length - 1];
  if (!r?.price_usd || !last?.close) return null;
  return { priceUsd: r.price_usd, changePct: (last.close - r.price_usd) / r.price_usd };
}
