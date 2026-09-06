import type { Address } from 'viem';
import { rules } from '../config.js';
import { db, setHealth, getHealth, recordMetric } from '../db.js';
import { log } from '../logger.js';
import { blockClock } from '../chain/client.js';
import { deployment, deploymentCached } from '../chain/deployment.js';
import { activeTokens } from '../chain/volume.js';
import { snapshotMarketCached, type Market } from '../chain/marketdata.js';
import { snapshotHolders, isWarm, type HolderSnapshot } from '../chain/holders.js';
import { notifier, type Notifier } from '../notify/notifier.js';
import { renderCard, renderButtons, type AlertData, type CardSources } from '../notify/render.js';
import {
  enrichSocial, emptyEnriched, withPlatformPnl, memberIds, sameMembers,
  type Enriched, type Top10Member,
} from './enrich.js';
import { targetWindow, type PnlRecord, type PnlWindow } from './pnl.js';
import { chainRejection, initialGate, recheckGate } from './rules.js';
import { confirmedWallets, recordAmountCandidates } from './wallets.js';
import type { FomoProvider } from '../fomo/provider.js';
import { HolderScheduler } from './scheduler.js';

const recentAlert = db.prepare("SELECT trigger_ts FROM alerts WHERE ca = ? AND trigger_ts > ? AND status != 'abandoned' LIMIT 1");
const insertAlert = db.prepare(
  `INSERT OR IGNORE INTO alerts (ca, trigger_ts, message_id, payload, status, recheck_due_ts, original_due_ts, attempts, firing_ts, notify_mode, collection_state, last_error, pnl_state)
   VALUES (?,?,NULL,NULL,'firing',?,?,0,?,?,'pending',NULL,'off')`,
);
const setAlertPending = db.prepare(
  `UPDATE alerts SET message_id=?, payload=?, status='pending_recheck', recheck_due_ts=?, last_error=NULL
   WHERE ca=? AND trigger_ts=?`,
);
/**
 * 完成必须是**条件更新**：重复恢复、重复完成都不能把一条已经终结的记录再改一次。
 * `collection_state` 与 `status` 分开——规则通过了，不代表数据采全了。
 */
const setAlertDone = db.prepare(
  `UPDATE alerts SET status=?, collection_state=?, recheck_due_ts=NULL, last_error=?, payload=?, pnl_state=?, pnl_deadline_ts=?
   WHERE ca=? AND trigger_ts=? AND status='pending_recheck'`,
);
const setPnlState = db.prepare('UPDATE alerts SET pnl_state=? WHERE ca=? AND trigger_ts=?');
const setPnlDone = db.prepare('UPDATE alerts SET pnl_state=?, payload=? WHERE ca=? AND trigger_ts=?');
const readAlert = db.prepare('SELECT status, message_id, pnl_state FROM alerts WHERE ca=? AND trigger_ts=?');
const setRetry = db.prepare(
  `UPDATE alerts SET recheck_due_ts=?, attempts=attempts+1, last_error=?, collection_state='pending'
   WHERE ca=? AND trigger_ts=?`,
);
const abandonAlert = db.prepare(
  `UPDATE alerts SET status='abandoned', collection_state='degraded', recheck_due_ts=NULL, last_error=?
   WHERE ca=? AND trigger_ts=?`,
);
const deleteAlert = db.prepare('DELETE FROM alerts WHERE ca = ? AND trigger_ts = ?');
const insertSnap = db.prepare(
  `INSERT OR REPLACE INTO holder_snapshots (ca, trigger_ts, stage, taken_ts, total_holders, fomo_holders, payload) VALUES (?,?,?,?,?,?,?)`,
);
/** 崩溃窗口取证：卡片发出去了、状态还没落库时，本地通知记录是唯一的证据。 */
const findSentMessage = db.prepare(
  `SELECT message_id FROM notification_log
   WHERE ca=? AND trigger_ts=? AND op='send' AND ok=1 AND message_id IS NOT NULL
   ORDER BY ts DESC LIMIT 1`,
);

/**
 * 一个采集阶段的**来源时间**。它们互不替代，也不取最小值揉成一个数。
 * 「刚抓到」≠「数据最新」：`chainBlockTs` 是链上事实的时间，`chainTakenTs` 是我们采完的时间。
 */
export interface SourceTimes {
  chainBlock: string | null;
  chainBlockTs: number | null;
  chainTakenTs: number | null;
  /** FOMO `/hodlers/top` 的响应时间 */
  fomoRespTs: number | null;
  boardTakenTs: number | null;
  /** 市值 / 成交量的取值时间 */
  marketTakenTs: number | null;
  aggregatedTs: number | null;
}

/**
 * 一次**持币采集阶段**的结果。
 *
 * `holdersDoneTs` 是这个阶段（链上快照 + FOMO 持币）真正完成的时刻，
 * 卡片上「持币初值（+…）／持币复核（+…）」的偏移只由它决定。
 * 后面再花多久取 PnL 都不会把这个偏移撑大——那是另一件事的耗时。
 */
export interface StageResult {
  total: number | null;
  e: Enriched;
  holdersDoneTs: number;
  times: SourceTimes;
}

interface StoredAlert {
  v?: number;
  m: Market;
  triggerTs: number;
  messageId: number | null;
  /** 原始到期时间，永远不被重试覆盖 */
  originalDueTs: number;
  /** 下一次重试时间 */
  recheckDueTs: number;
  attempts: number;
  initial: StageResult;
  recheck?: StageResult;
}

/** 一批全平台 24H 收益：窗口、逐人记录、成员集合、获取完成时间。 */
interface PnlBatch {
  window: PnlWindow | null;
  records: Map<string, PnlRecord>;
  members: Top10Member[];
  fetchedTs: number;
}

/** 快照门拒绝后的冷却时长。够短，让条件变化的币还有机会；够长，不至于每秒空转。 */
const REJECT_COOLDOWN_MS = 90_000;
const RECHECK_RETRY_MS = 60_000;
/** 复核的重试期限：超过原定到期时间这么久还采不全，就终结为「降级」，不再无限重试。 */
const RECHECK_DEADLINE_MS = 15 * 60_000;

/** PnL 预取提前量：复核到期前这么久开始，用已知成员先把序列拿到手。 */
const PNL_PREFETCH_LEAD_MS = Number(process.env.FOMO_PNL_PREFETCH_LEAD_MS ?? 120_000);
/** PnL 后续补取的期限（相对**原定**到期时间）。超过就终结，不再无限堆积。 */
const PNL_FOLLOWUP_DEADLINE_MS = Number(process.env.FOMO_PNL_FOLLOWUP_DEADLINE_MS ?? 10 * 60_000);
const PNL_FOLLOWUP_MAX_ATTEMPTS = 2;
const PNL_FOLLOWUP_RETRY_MS = 45_000;

/** 链上与 FOMO 两侧允许的采集时间差；超了就在卡片上标出来，不当成同一时点。 */
const MAX_SOURCE_SKEW_MS = Number(process.env.FOMO_MAX_SOURCE_SKEW_MS ?? 120_000);
/** 单个来源允许的数据年龄。 */
const MAX_SOURCE_AGE_MS = Number(process.env.FOMO_MAX_SOURCE_AGE_MS ?? 600_000);

const alertKey = (ca: string, triggerTs: number) => `${ca}|${triggerTs}`;

export class Engine {
  private prewarmAt = new Map<string, number>();
  private inflight = 0;
  private firing = new Set<string>();
  /** 已经接管过的 (ca, triggerTs)，防止重复恢复同一条任务 */
  private resumed = new Set<string>();
  private readonly holders$: HolderScheduler<HolderSnapshot>;
  private rejectedUntil = new Map<string, number>();

  /** 预取好的全平台收益，按告警存。到期时**同步**取用，绝不让复核等它。 */
  private pnlReady = new Map<string, PnlBatch>();
  /**
   * 正在跑的取数任务。同一条告警**不会重复启动**同一个任务——
   * 后来者直接等在跑的那个上，而不是被拒掉白白浪费一次尝试机会。
   */
  private pnlTasks = new Map<string, { kind: 'prefetch' | 'followup'; startedTs: number; task: Promise<PnlBatch | null> }>();
  /** 已撤回或已失效的告警：迟到的 PnL 结果不得再更新它们。 */
  private pnlCancelled = new Map<string, number>();

  constructor(
    private readonly fomo: FomoProvider,
    private readonly signal?: AbortSignal,
    private readonly notify: Notifier = notifier,
  ) {
    this.holders$ = new HolderScheduler<HolderSnapshot>(3, signal);
  }

  /** 心跳与验收报告用：调度器与浏览器导航的排队深度。 */
  queueDepth() {
    return { holders: this.holders$.depth(), pnlTasks: this.pnlTasks.size, pnlReady: this.pnlReady.size };
  }

  /**
   * 重启后的恢复。要处理五种历史遗留：
   *   1. 正常的 pending_recheck（有 payload）；
   *   2. 异常退出留下的 firing——卡可能已经发出去了（发送成功、状态未落库的崩溃窗口），
   *      靠本地通知记录判断，不能一律当没发过；**任何情况下都不会重发初值卡片**；
   *   3. 损坏的 payload；
   *   4. 重复恢复（同一条被接管两次）；
   *   5. 复核已完成、只差 PnL 的（`pnl_state='pending'`）——在期限内接着补，
   *      过了期限就终结为 timeout，不再无限堆积。
   */
  resumePending(): { resumed: number; orphanFiring: number; corrupt: number; pnlResumed: number } {
    let corrupt = 0, orphanFiring = 0, resumed = 0, pnlResumed = 0;

    for (const row of db.prepare(
      `SELECT ca, trigger_ts, message_id FROM alerts WHERE status='firing'`).all() as any[]) {
      const sent = findSentMessage.get(row.ca, row.trigger_ts) as { message_id: number } | undefined;
      orphanFiring++;
      if (sent) {
        // 卡片确实发出去了，只是状态没来得及落库。保留记录并标成降级，等人来看。
        // **不会**重新发一张初值卡——重复通知比缺一条状态更糟。
        abandonAlert.run(`异常退出遗留 firing；已发出 message_id=${sent.message_id}，缺少复核状态`, row.ca, row.trigger_ts);
        log.warn({ ca: row.ca, messageId: sent.message_id }, '发现「已发送但状态未落库」的遗留告警，标记为降级');
      } else {
        // 没有任何发送记录 → 这张卡从没发出去，占位行删掉，别让 dedup 拿它拉黑这个币。
        deleteAlert.run(row.ca, row.trigger_ts);
      }
    }

    const rows = db.prepare(
      `SELECT ca, trigger_ts, message_id, payload, recheck_due_ts, original_due_ts, attempts FROM alerts
       WHERE status='pending_recheck'`).all() as any[];
    for (const row of rows) {
      const key = alertKey(row.ca, row.trigger_ts);
      if (this.resumed.has(key)) continue;                    // 重复恢复：忽略
      if (row.payload === null) {
        corrupt++;
        abandonAlert.run('pending_recheck 但没有 payload，无法恢复', row.ca, row.trigger_ts);
        continue;
      }
      let state: StoredAlert;
      try {
        state = normalizeStored(JSON.parse(row.payload));
      } catch (err) {
        corrupt++;
        abandonAlert.run(`恢复 payload 失败: ${String(err).slice(0, 160)}`, row.ca, row.trigger_ts);
        log.warn({ ca: row.ca, err: String(err).slice(0, 120) }, '复核 payload 损坏，标记为降级');
        continue;
      }
      this.resumed.add(key);
      state.messageId = row.message_id ?? state.messageId ?? null;
      state.originalDueTs = row.original_due_ts ?? state.originalDueTs ?? state.recheckDueTs;
      state.recheckDueTs = row.recheck_due_ts ?? state.recheckDueTs;
      state.attempts = row.attempts ?? 0;
      resumed++;
      this.schedulePnlPrefetch(state);
      void this.runRecheck(state).catch(err =>
        log.error({ ca: state.m.ca, err: String(err).slice(0, 180) }, '恢复的复核任务异常退出'));
    }

    // 复核已完成、只差 PnL 的：在期限内接着补，同一张卡原地改写。
    for (const row of db.prepare(
      `SELECT ca, trigger_ts, payload, pnl_deadline_ts FROM alerts
       WHERE status='completed' AND pnl_state='pending' AND payload IS NOT NULL`).all() as any[]) {
      if (!row.pnl_deadline_ts || Date.now() > row.pnl_deadline_ts) {
        setPnlState.run('timeout', row.ca, row.trigger_ts);
        continue;
      }
      try {
        const state = normalizeStored(JSON.parse(row.payload));
        if (!state.recheck) { setPnlState.run('timeout', row.ca, row.trigger_ts); continue; }
        pnlResumed++;
        this.startPnlFollowUp(state, row.pnl_deadline_ts);
      } catch {
        setPnlState.run('timeout', row.ca, row.trigger_ts);
      }
    }
    return { resumed, orphanFiring, corrupt, pnlResumed };
  }

  sweep(): void {
    const now = Date.now();
    for (const [k, t] of this.prewarmAt) if (now - t > 30 * 60_000) this.prewarmAt.delete(k);
    for (const [k, t] of this.rejectedUntil) if (now > t) this.rejectedUntil.delete(k);
    for (const [k, b] of this.pnlReady) if (now - b.fetchedTs > 60 * 60_000) this.pnlReady.delete(k);
    for (const [k, t] of this.pnlCancelled) if (now - t > 60 * 60_000) this.pnlCancelled.delete(k);
  }

  async tick(): Promise<void> {
    if (this.signal?.aborted) return;
    const triggerTs = Date.now();
    const cutoff = triggerTs - rules.dedup.cooldown_minutes * 60_000;
    const candidates = activeTokens(5 * 60_000, 300);
    setHealth('universe_size', candidates.length);
    if (getHealth('volume_window_complete')?.value !== 'true' || getHealth('pool_backfill')?.value !== 'ok') {
      setHealth('engine_not_warm', candidates.length);
      setHealth('engine_eligible', 0);
      return;
    }
    let notWarm = 0, eligible = 0;

    for (const c of candidates) {
      if (this.firing.has(c.ca)) continue;
      if (recentAlert.get(c.ca, cutoff)) continue;
      const until = this.rejectedUntil.get(c.ca);
      if (until && triggerTs < until) continue;

      const m = snapshotMarketCached(c.ca);
      if (!m) continue;
      if (chainRejection(m, rules.filters) !== null) continue;

      const dep = deploymentCached(c.ca);
      const fomoWarm = !this.fomo.ready || this.fomo.tokenStatsWarm(c.ca, 60_000);
      if (!dep || !isWarm(c.ca) || !fomoWarm) { this.prewarm(c.ca); notWarm++; continue; }

      const age = triggerTs - dep.ts;
      if (age > rules.universe.max_age_minutes * 60_000) continue;
      if (age < rules.universe.min_age_seconds * 1000) continue;
      eligible++;
      void this.fire(m, triggerTs).catch(err =>
        log.error({ ca: c.ca, err: String(err).slice(0, 200) }, '触发流程抛出未捕获异常'));
    }
    setHealth('engine_not_warm', notWarm);
    setHealth('engine_eligible', eligible);
  }

  private prewarm(ca: string): void {
    if (this.signal?.aborted) return;
    const last = this.prewarmAt.get(ca);
    if ((last && Date.now() - last < 30_000) || this.inflight >= 3) return;
    this.prewarmAt.set(ca, Date.now());
    this.inflight++;
    void (async () => {
      try {
        const c = await deployment(ca);
        if (!c) { log.debug({ ca }, '查不到部署区块，稍后重试预热'); return; }
        await this.scheduleHolder('prewarm', async () =>
          snapshotHolders(ca as Address, c.block, await blockClock.sync()));
      } catch (err) {
        log.debug({ ca, err: String(err).slice(0, 120) }, '预热持币表失败');
      } finally { this.inflight--; }
    })();
    if (this.fomo.ready) {
      void this.fomo.tokenStats(ca, 60_000, 'prewarm').catch(err =>
        log.debug({ ca, err: String(err).slice(0, 120) }, '预热 FOMO 数据失败'));
    }
  }

  private async holders(ca: string, kind: 'initial' | 'recheck'): Promise<HolderSnapshot | null> {
    const c = deploymentCached(ca);
    if (!c) return null;
    return this.scheduleHolder(kind, async () =>
      snapshotHolders(ca as Address, c.block, await blockClock.sync()));
  }

  private scheduleHolder(kind: 'initial' | 'recheck' | 'prewarm', run: () => Promise<HolderSnapshot>): Promise<HolderSnapshot> {
    return this.holders$.schedule(kind, run);
  }

  /** 触发后的完整流程：+0.8s 快照 → 发消息 → +5m1s 复核 → 改写消息。 */
  private async fire(m: Market, triggerTs: number): Promise<void> {
    this.firing.add(m.ca);
    let placed = false, pending = false;
    try {
      const originalDueTs = triggerTs + rules.scan.recheck_delay_ms;
      insertAlert.run(m.ca, triggerTs, originalDueTs, originalDueTs, Date.now(), this.notify.mode);
      placed = true;
      log.info({ symbol: m.symbol, mc: Math.round(m.marketCapUsd), v5m: Math.round(m.volume5m) }, '🔔 触发');
      await sleep(rules.scan.snapshot_delay_ms, this.signal);

      // 初值只做持币采集阶段：**不**等全平台收益（那是十次浏览器导航，几十秒起步）。
      const initial = await this.collectStage(m, triggerTs, 'initial', 60_000, 'alert');
      const initialOffsetMs = initial.holdersDoneTs - triggerTs;
      insertSnap.run(m.ca, triggerTs, 'initial', initial.holdersDoneTs, initial.total, initial.e.fomoHolders,
        JSON.stringify(initial.times));
      recordMetric('initial_latency_ms', initialOffsetMs, m.ca);
      this.recordAges(initial, m.ca);

      const gate = initialGate(initial.total, initial.e, rules.filters);
      if (gate.kind !== 'pass') {
        deleteAlert.run(m.ca, triggerTs);
        this.rejectedUntil.set(m.ca, Date.now() + REJECT_COOLDOWN_MS);
        log.info({ symbol: m.symbol, 原因: gate.reason, 类型: gate.kind }, '快照门未通过，不推送');
        return;
      }

      const state: StoredAlert = {
        v: 2, m, triggerTs, messageId: null,
        originalDueTs, recheckDueTs: originalDueTs, attempts: 0, initial,
      };
      const data = this.buildCard(state, 'collecting');
      const sent = await this.notify.send(renderCard(data), renderButtons(m.ca), { ca: m.ca, triggerTs });
      if (!sent) throw new Error('通知发送失败，未取得 message_id');
      state.messageId = sent.messageId;

      setAlertPending.run(sent.messageId, JSON.stringify(state), originalDueTs, m.ca, triggerTs);
      pending = true;
      this.resumed.add(alertKey(m.ca, triggerTs));
      // 复核到期前用**已知成员**有界预取，到期时能直接命中，不占复核的时间。
      this.schedulePnlPrefetch(state);
      await this.runRecheck(state);
    } catch (err) {
      if (placed && !pending) {
        try { deleteAlert.run(m.ca, triggerTs); } catch { /* 尽力而为 */ }
        this.rejectedUntil.set(m.ca, Date.now() + REJECT_COOLDOWN_MS);
      }
      log.error({ ca: m.ca, err: String(err).slice(0, 200) }, '触发流程出错');
    } finally {
      this.firing.delete(m.ca);
    }
  }

  private async runRecheck(state: StoredAlert): Promise<void> {
    const { m, triggerTs } = state;
    this.firing.add(m.ca);
    try {
      while (!this.signal?.aborted) {
        try { await sleep(Math.max(0, state.recheckDueTs - Date.now()), this.signal); }
        catch { return; }                                   // 中止：pending 状态保留，下次启动恢复
        if (this.signal?.aborted) return;

        let outcome: 'done' | 'retry' = 'retry';
        try {
          outcome = await this.attemptRecheck(state);
        } catch (err) {
          if (this.signal?.aborted) return;
          this.scheduleRetry(state, `复核异常: ${String(err).slice(0, 160)}`);
          log.warn({ ca: m.ca, err: String(err).slice(0, 180) }, '复核失败，保留任务稍后重试');
          // 注意**不能** continue：那样会跳过下面的期限检查，
          // 一个持续抛异常的复核就会永远重试下去。
        }
        if (outcome === 'done') return;

        // 采集没完成。超过期限就终结为降级，绝不无限重试，也绝不当成成功。
        if (Date.now() > state.originalDueTs + RECHECK_DEADLINE_MS) {
          abandonAlert.run(`复核数据始终不完整（${state.attempts} 次尝试）`, m.ca, triggerTs);
          this.cancelPnl(alertKey(m.ca, triggerTs));
          log.warn({ ca: m.ca, attempts: state.attempts }, '复核超出重试期限，终结为降级状态');
          return;
        }
      }
    } finally { this.firing.delete(m.ca); }
  }

  /** 返回 'done' = 这条告警已终结（完成或撤回）；'retry' = 数据不全，需要再来一次。 */
  private async attemptRecheck(state: StoredAlert): Promise<'done' | 'retry'> {
    const { m, triggerTs } = state;
    const key = alertKey(m.ca, triggerTs);

    // ① 持币采集阶段。到这一步就结算偏移——后面取 PnL 花多久都不再改这个数。
    const recheck = await this.collectStage(m, triggerTs, 'recheck', 2_000, 'recheck');
    insertSnap.run(m.ca, triggerTs, 'recheck', recheck.holdersDoneTs, recheck.total, recheck.e.fomoHolders,
      JSON.stringify(recheck.times));
    // 复核延迟量的是「持币采集完成 − **原定**到期时间」，既不是相对上一次重试，
    // 也不含后续 PnL 的耗时。
    recordMetric('recheck_lateness_ms', recheck.holdersDoneTs - state.originalDueTs, m.ca);
    recordMetric('recheck_attempts', state.attempts, m.ca);
    this.recordAges(recheck, m.ca);

    const gate = recheckGate(recheck.total, recheck.e, rules.filters);

    // 数据没采全：既不能标完成，也不能撤回——不知道该不该撤的时候撤，就是误撤。
    if (gate.kind === 'missing') {
      this.scheduleRetry(state, `复核数据不完整: ${gate.reason}`);
      log.info({ ca: m.ca, 原因: gate.reason, 尝试: state.attempts }, '复核数据不完整，保留卡片并重试');
      return 'retry';
    }

    if (gate.kind === 'reject') {
      if (state.messageId !== null) {
        const removed = await this.notify.remove(state.messageId, { ca: m.ca, triggerTs });
        if (!removed) throw new Error('撤回失败');
      }
      deleteAlert.run(m.ca, triggerTs);
      this.cancelPnl(key);                       // 已撤回的告警不能被迟到的 PnL 再更新
      this.rejectedUntil.set(m.ca, Date.now() + REJECT_COOLDOWN_MS);
      log.info({ symbol: m.symbol, 原因: gate.reason }, '复核门未通过，已撤回');
      return 'done';
    }

    // ② 到期时重新确定实际 Top10，复用**成员与窗口都匹配**的预取结果。
    //    新增成员没有记录 → 合计判缺失，绝不沿用旧 Top10 的总和。
    const batch = this.pnlReady.get(key);
    const reused = batch?.records ?? new Map<string, PnlRecord>();
    recheck.e = withPlatformPnl(recheck.e, reused);
    const membersChanged = batch ? !sameMembers(batch.members, recheck.e.top10Members) : false;
    const pnlPending = recheck.e.top10PlatformPnl24h === null && this.canFetchPnl(recheck.e.top10Members);

    state.recheck = recheck;
    const data2 = this.buildCard(state, pnlPending ? 'collecting' : 'ready');
    if (state.messageId !== null) {
      const edited = await this.notify.edit(state.messageId, renderCard(data2), renderButtons(m.ca), { ca: m.ca, triggerTs });
      if (!edited) throw new Error('改写失败');
    }
    recordMetric('card_update_lateness_ms', Date.now() - state.originalDueTs, `${m.ca} recheck`);

    // 规则通过 ≠ 数据齐全。可选数据缺失时如实记成 degraded，而不是 complete。
    const complete = recheck.e.available && recheck.e.leaderboardAvailable && recheck.total !== null;
    const pnlDeadline = state.originalDueTs + PNL_FOLLOWUP_DEADLINE_MS;
    setAlertDone.run('completed', complete ? 'complete' : 'degraded',
      complete ? null : '规则通过但部分可选数据缺失',
      JSON.stringify(state), pnlPending ? 'pending' : (recheck.e.top10PlatformPnl24h === null ? 'off' : 'ready'),
      pnlPending ? pnlDeadline : null, m.ca, triggerTs);

    if (pnlPending) {
      log.info({ ca: m.ca, 成员变化: membersChanged, 已复用: reused.size },
        '复核已完成，全平台收益稍后原地补上');
      this.startPnlFollowUp(state, pnlDeadline);
    }
    return 'done';
  }

  private scheduleRetry(state: StoredAlert, reason: string): void {
    state.attempts++;
    recordMetric('recheck_retry', 1, `${state.m.ca} ${reason.slice(0, 60)}`);
    // 原定到期时间保留在 originalDueTs，重试只改 recheckDueTs。
    state.recheckDueTs = Date.now() + RECHECK_RETRY_MS;
    setRetry.run(state.recheckDueTs, reason.slice(0, 180), state.m.ca, state.triggerTs);
  }

  // ── 全平台 24H 收益：完全在持币关键路径之外 ──────────────────────────

  private canFetchPnl(members: Top10Member[]): boolean {
    return Boolean(this.fomo.platformPnl24h) && this.fomo.ready
      && members.length > 0 && members.every(x => x.userId);
  }

  private cancelPnl(key: string): void {
    this.pnlCancelled.set(key, Date.now());
    this.pnlReady.delete(key);
  }

  /**
   * 复核到期**之前**用已知成员预取。窗口按**原定到期时间**的整点定，
   * 这样到期那一刻算出来的目标窗口跟预取的是同一个，能直接命中。
   */
  private schedulePnlPrefetch(state: StoredAlert): void {
    const key = alertKey(state.m.ca, state.triggerTs);
    const members = state.initial.e.top10Members;
    if (!this.canFetchPnl(members)) return;
    const at = state.originalDueTs - PNL_PREFETCH_LEAD_MS;
    void (async () => {
      try { await sleep(Math.max(0, at - Date.now()), this.signal); } catch { return; }
      if (this.signal?.aborted || this.pnlCancelled.has(key)) return;
      await this.runPnl(key, members, state.originalDueTs, 'prefetch');
    })();
  }

  /**
   * 取一批全平台收益。同一条告警**不会重复启动**同一个任务。
   * 目标窗口由这里统一确定（`targetWindow`），十个人共用。
   */
  private async runPnl(key: string, members: Top10Member[], preferredAtTs: number,
                       kind: 'prefetch' | 'followup'): Promise<PnlBatch | null> {
    if (!this.fomo.platformPnl24h || this.signal?.aborted || this.pnlCancelled.has(key)) return null;
    const inflight = this.pnlTasks.get(key);
    if (inflight) return inflight.task;          // 已经在跑：等它，不另起一个
    const task = this.fetchPnl(key, members, preferredAtTs, kind);
    this.pnlTasks.set(key, { kind, startedTs: Date.now(), task });
    try { return await task; } finally { this.pnlTasks.delete(key); }
  }

  private async fetchPnl(key: string, members: Top10Member[], preferredAtTs: number,
                         kind: 'prefetch' | 'followup'): Promise<PnlBatch | null> {
    const t0 = Date.now();
    try {
      const want = targetWindow(preferredAtTs);
      const ids = memberIds(members).filter((x): x is string => Boolean(x));
      const res = await this.fomo.platformPnl24h!(ids, want.endTs);
      const batch: PnlBatch = { window: res.window, records: res.records, members, fetchedTs: Date.now() };
      recordMetric('pnl_ready_ms', Date.now() - t0, `${kind} ${res.records.size}/${ids.length}`);
      if (res.misses.size) {
        log.debug({ 缺失: [...res.misses.entries()].map(([id, why]) => `${id.slice(0, 8)}:${why}`) }, '全平台收益部分缺失');
      }
      if (this.pnlCancelled.has(key)) return null;
      this.pnlReady.set(key, batch);
      return batch;
    } catch (err) {
      log.debug({ err: String(err).slice(0, 140) }, '取全平台 24H 收益失败');
      return null;
    }
  }

  /**
   * 复核已经完成之后，把全平台收益补上并**原地改写同一条卡片**。
   *
   * 明确的状态与规则：
   *  - 有截止时间（相对原定到期），过了就终结为 timeout，不再重试也不再堆积；
   *  - 尝试次数有上限；
   *  - 告警被撤回/降级/消息 id 变了，一律放弃，不去改一条已经不存在的卡；
   *  - 收到退出信号立即停止。
   */
  private startPnlFollowUp(state: StoredAlert, deadlineTs: number): void {
    const key = alertKey(state.m.ca, state.triggerTs);
    if (!state.recheck || !this.canFetchPnl(state.recheck.e.top10Members)) return;
    void (async () => {
      try {
        for (let attempt = 1; attempt <= PNL_FOLLOWUP_MAX_ATTEMPTS; attempt++) {
          if (this.settleFollowUp(state, key, deadlineTs)) return;

          let batch: PnlBatch | null = null;
          try {
            batch = await this.runPnl(key, state.recheck!.e.top10Members, Date.now(), 'followup');
          } catch (err) {
            log.warn({ ca: state.m.ca, err: String(err).slice(0, 160) }, '补取全平台收益失败，按重试处理');
          }
          /**
           * 取数可能花上百秒。回来之后**必须重新**检查中止、撤回和截止时间——
           * 只在取数前检查是不够的：等待期间告警可能已经被撤回，或者已经超期，
           * 那就绝不能再去改那张卡。
           */
          if (this.settleFollowUp(state, key, deadlineTs)) return;

          if (batch) {
            try {
              if (await this.applyPnl(state, batch, deadlineTs)) return;
            } catch (err) {
              // 改写失败不是「这条任务完了」，是「这一次没成」——交给下一次尝试或期限终结。
              log.warn({ ca: state.m.ca, err: String(err).slice(0, 160) }, '补入全平台收益时改写卡片失败');
            }
          }
          if (attempt < PNL_FOLLOWUP_MAX_ATTEMPTS) {
            try { await sleep(PNL_FOLLOWUP_RETRY_MS, this.signal); } catch { return; }
          }
        }
        if (this.signal?.aborted || this.pnlCancelled.has(key)) return;
        setPnlState.run('timeout', state.m.ca, state.triggerTs);
        log.info({ ca: state.m.ca }, '全平台收益补取超期，卡片保持 n/a');
      } catch (err) {
        /**
         * 兜底。这是个 `void` 掉的异步任务，抛出去就是**未处理的 Promise rejection**，
         * 在 Node 里会直接结束整个监控进程。任何异常都必须在这里落地成一条记录 + 一个终态。
         */
        log.error({ ca: state.m.ca, err: String(err).slice(0, 200) }, 'PnL 补卡任务异常退出，终结为 timeout');
        try { setPnlState.run('timeout', state.m.ca, state.triggerTs); } catch { /* 尽力而为 */ }
      }
    })();
  }

  /**
   * 补卡任务该不该就此停下。三种停法各有各的善后：
   *  - 收到退出信号：**不动数据库**，保持 `pending`，下次启动接着补；
   *  - 告警已撤回/失效：什么都不用做，行都没了；
   *  - 过了截止时间：终结为 `timeout`，卡片保持 n/a，不再重试也不再堆积。
   */
  private settleFollowUp(state: StoredAlert, key: string, deadlineTs: number): boolean {
    if (this.signal?.aborted) return true;
    if (this.pnlCancelled.has(key)) return true;
    if (Date.now() > deadlineTs) {
      setPnlState.run('timeout', state.m.ca, state.triggerTs);
      log.info({ ca: state.m.ca }, '全平台收益补取超期，卡片保持 n/a');
      return true;
    }
    return false;
  }

  /** 返回 true = 这条告警的 PnL 已经终结（补上了，或不该再补）。 */
  private async applyPnl(state: StoredAlert, batch: PnlBatch, deadlineTs = Infinity): Promise<boolean> {
    const { m, triggerTs } = state;
    if (!state.recheck) return true;
    const key = alertKey(m.ca, triggerTs);
    // 自己也守一道：这个函数可能在一次上百秒的取数之后才被调用。
    if (this.signal?.aborted || this.pnlCancelled.has(key) || Date.now() > deadlineTs) return true;

    const row = readAlert.get(m.ca, triggerTs) as { status: string; message_id: number | null; pnl_state: string } | undefined;
    // 已撤回（行没了）、已降级、或消息换了 id：迟到的结果一律不得再更新。
    if (!row || row.status !== 'completed' || row.message_id !== state.messageId) {
      this.cancelPnl(key);
      return true;
    }

    const merged = withPlatformPnl(state.recheck.e, batch.records);
    if (merged.top10PlatformPnl24h === null) return false;     // 还是不齐，交给下一次尝试

    /**
     * 只换 PnL：持币初值/复核的人数、采集时间、偏移、市值来源时间全部原样保留。
     * 先在**副本**上算，改写真的成功了才落回 `state`——否则 edit 抛异常会留下
     * 一个「卡片没变、内存里却当成已补上」的半截状态。
     */
    const next: StoredAlert = { ...state, recheck: { ...state.recheck, e: merged } };
    if (state.messageId !== null) {
      const ok = await this.notify.edit(state.messageId, renderCard(this.buildCard(next, 'ready')),
        renderButtons(m.ca), { ca: m.ca, triggerTs });
      if (!ok) return false;
    }
    state.recheck = next.recheck;
    setPnlDone.run('ready', JSON.stringify(state), m.ca, triggerTs);
    recordMetric('card_update_lateness_ms', Date.now() - state.originalDueTs, `${m.ca} pnl`);
    recordMetric('pnl_followup_lateness_ms', Date.now() - state.originalDueTs, m.ca);
    log.info({ ca: m.ca, 合计: merged.top10PlatformPnl24h, 盈利: merged.top10PlatformProfitable24h },
      '全平台 24H 收益已补入同一张卡片');
    return true;
  }

  // ── 采集与渲染 ──────────────────────────────────────────────────────

  /**
   * 一个持币采集阶段：链上快照 + FOMO 持币/榜单。**不含**全平台收益。
   * 返回的 `holdersDoneTs` 就是这个阶段的完成时刻。
   */
  private async collectStage(m: Market, triggerTs: number, kind: 'initial' | 'recheck',
                             maxAgeMs: number, priority: 'alert' | 'recheck'): Promise<StageResult> {
    void triggerTs;
    const snap = await this.holders(m.ca, kind);
    const e = await this.enrich(m, snap, maxAgeMs, priority);
    const holdersDoneTs = Date.now();
    return {
      total: snap?.total ?? null,
      e,
      holdersDoneTs,
      times: {
        chainBlock: snap ? String(snap.atBlock) : null,
        chainBlockTs: snap?.blockTs ?? null,
        chainTakenTs: snap?.takenTs ?? null,
        fomoRespTs: e.fomoTakenTs,
        boardTakenTs: e.boardTakenTs,
        marketTakenTs: Date.now(),
        aggregatedTs: e.aggregatedTs,
      },
    };
  }

  private recordAges(stage: StageResult, ca: string): void {
    const at = stage.holdersDoneTs;
    const t = stage.times;
    if (t.chainBlockTs !== null) recordMetric('age_chain_ms', at - t.chainBlockTs, ca);
    if (t.chainTakenTs !== null) recordMetric('age_chain_taken_ms', at - t.chainTakenTs, ca);
    if (t.fomoRespTs !== null) recordMetric('age_fomo_ms', at - t.fomoRespTs, ca);
    if (t.boardTakenTs !== null) recordMetric('age_board_ms', at - t.boardTakenTs, ca);
    if (t.chainTakenTs !== null && t.fomoRespTs !== null) {
      recordMetric('source_skew_ms', Math.abs(t.fomoRespTs - t.chainTakenTs), ca);
    }
  }

  /** 社交层数据。**不取**全平台 24H 收益——那条路径完全在持币关键路径之外。 */
  private async enrich(m: Market, snap: HolderSnapshot | null, maxAgeMs = 60_000,
                       priority: 'recheck' | 'alert' = 'alert'): Promise<Enriched> {
    if (!this.fomo.ready) return emptyEnriched();
    const stats = await this.fomo.tokenStats(m.ca, maxAgeMs, priority);
    if (!stats) return emptyEnriched();
    const board = await this.fomo.leaderboard24h();
    const boardFresh = board.length > 0 && Date.now() - Math.max(...board.map(b => b.updatedTs)) <= 10 * 60_000;
    const currentBoard = boardFresh ? board : [];

    // 金额匹配只记候选，不参与身份统计；统计只用已确认映射。
    if (snap) {
      try { recordAmountCandidates(m.decimals, snap, stats, m.ca); }
      catch (err) { log.debug({ ca: m.ca, err: String(err).slice(0, 120) }, '记录钱包候选失败'); }
    }
    /**
     * 榜单自带的 `pnl24h` **不**补进 Top10 的合计。
     *
     * 它是「实时累计 − 24 小时前整点」，窗口右端是抓取那一刻；
     * `aggregatedSnapshot` 那条是两端都对齐整点的。两者不是同一个 24 小时，
     * 混着求和就是把两个窗口的数加在一起（docs/FIELDS.md §2.3）。
     * 榜单值仍然用在「盈利榜持有人」那几行——那里它是逐人展示，不参与求和。
     */
    return enrichSocial(m.decimals, snap, stats, currentBoard, boardFresh, confirmedWallets());
  }

  /** 各来源时间与降级判定。超出允许年龄或时间差就如实标出，不当成同一时点。 */
  private sourceInfo(stage: StageResult, atTs: number): CardSources {
    const t = stage.times;
    const degraded: string[] = [];
    const skew = t.chainTakenTs !== null && t.fomoRespTs !== null ? t.fomoRespTs - t.chainTakenTs : null;
    if (skew !== null && Math.abs(skew) > MAX_SOURCE_SKEW_MS) {
      degraded.push(`链上与 Fomo 采集相差 ${Math.round(Math.abs(skew) / 1000)}s`);
    }
    const age = (label: string, ts: number | null) => {
      if (ts === null) { degraded.push(`${label}时间缺失`); return; }
      if (atTs - ts > MAX_SOURCE_AGE_MS) degraded.push(`${label}数据已 ${Math.round((atTs - ts) / 60_000)} 分钟`);
    };
    age('链上', t.chainTakenTs);
    age('Fomo', t.fomoRespTs);
    if (t.boardTakenTs !== null && atTs - t.boardTakenTs > MAX_SOURCE_AGE_MS) {
      degraded.push(`榜单数据已 ${Math.round((atTs - t.boardTakenTs) / 60_000)} 分钟`);
    }
    return {
      chainBlock: t.chainBlock, chainBlockTs: t.chainBlockTs, chainTakenTs: t.chainTakenTs,
      fomoRespTs: t.fomoRespTs, boardTakenTs: t.boardTakenTs, marketTakenTs: t.marketTakenTs,
      sourceSkewMs: skew, degraded,
    };
  }

  /**
   * 由**已保存的阶段结果**渲染卡片。
   *
   * 关键：偏移只来自各阶段的 `holdersDoneTs`。后续补 PnL 时这个函数拿到的
   * `state.initial` / `state.recheck` 原样没变，所以初值人数、复核人数、
   * 两个偏移、市值来源时间都不会因为补一个字段而悄悄改变。
   */
  private buildCard(state: StoredAlert, pnlState: 'ready' | 'collecting'): AlertData {
    const { m, triggerTs, initial, recheck } = state;
    const latest = recheck ?? initial;
    const e = latest.e;
    const initialOffsetMs = initial.holdersDoneTs - triggerTs;
    const recheckOffsetMs = recheck ? recheck.holdersDoneTs - triggerTs : 0;
    return {
      ca: m.ca, symbol: m.symbol, name: m.name,
      marketCapUsd: m.marketCapUsd, triggerTs,
      volume5m: m.volume5m, volume1h: m.volume1h,
      initial: initial.total !== null
        ? { total: initial.total, fomo: initial.e.fomoHolders, offsetMs: initialOffsetMs } : null,
      recheck: recheck && recheck.total !== null
        ? { total: recheck.total, fomo: recheck.e.fomoHolders, offsetMs: recheckOffsetMs } : null,
      leaderboardHolders: e.leaders,
      leaderboardAvailable: e.leaderboardAvailable,
      // 身份覆盖不全 → 交集只能说「已确认至少 N 人」
      leaderboardPartial: e.fomoHolders !== null && e.identityCoverage < e.fomoHolders,
      top10: {
        tokenPnlTotal: e.top10TokenPnl,
        tokenPnlCovered: e.top10TokenPnlCovered,
        tokenProfitable: e.top10TokenProfitable,
        platformPnl24h: e.top10PlatformPnl24h,
        platformProfitable: e.top10PlatformProfitable24h,
        platformCovered: e.top10PlatformCovered,
        platformWindow: e.top10PlatformWindow,
        platformFetchedTs: e.top10PlatformFetchedTs,
        platformState: e.top10PlatformPnl24h === null ? pnlState : 'ready',
        platformReason: e.top10PlatformPnl24h === null ? e.top10PlatformReason : null,
        identified: e.identified,
        // 实际集合大小，不再拿另一个集合的人数回填
        count: e.top10Count,
        // Top10 持仓集合的时间 = 该阶段持币采集完成时间，与收益窗口分开显示
        offsetMs: recheck ? recheckOffsetMs : initialOffsetMs,
      },
      sources: this.sourceInfo(latest, latest.holdersDoneTs),
      health: {
        sourceOk: this.sourcesHealthy(e),
        holderCoverage: e.fomoHolders !== null ? [e.identityCoverage, e.fomoHolders] : null,
        ingestMs: e.ingestMs,
        notifyMode: this.notify.mode,
      },
    };
  }

  private sourcesHealthy(e: Enriched): boolean {
    const chainHealth = getHealth('chain_source');
    const lag = Number(getHealth('chain_lag_blocks')?.value ?? Infinity);
    const quote = getHealth('quote_price');
    const chainOk = chainHealth?.value === 'ok' && Date.now() - chainHealth.ts < 15_000 && lag === 0
      && quote?.value === 'ok' && Date.now() - quote.ts < 120_000;
    const fomoOk = e.available && e.leaderboardAvailable && e.fomoTakenTs !== null
      && Date.now() - e.fomoTakenTs < 10 * 60_000;
    return chainOk && fomoOk;
  }
}

/**
 * 兼容旧 payload。整改前存的是扁平的 `initE / initialTotal / initialOffsetMs`，
 * 重启后照样要能接上——但**偏移不能凭空造**：旧记录只有偏移没有完成时刻，
 * 就用 `triggerTs + 偏移` 还原出完成时刻，语义等价，不会把数字改掉。
 */
function normalizeStored(raw: any): StoredAlert {
  if (!raw?.m?.ca || typeof raw.triggerTs !== 'number') throw new Error('payload 结构不完整');
  if (raw.initial && typeof raw.initial.holdersDoneTs === 'number') return raw as StoredAlert;
  const emptyTimes: SourceTimes = {
    chainBlock: null, chainBlockTs: null, chainTakenTs: null,
    fomoRespTs: null, boardTakenTs: null, marketTakenTs: null, aggregatedTs: null,
  };
  const legacyE = { ...emptyEnriched(), ...(raw.initE ?? {}) } as Enriched;
  return {
    v: 2,
    m: raw.m,
    triggerTs: raw.triggerTs,
    messageId: raw.messageId ?? null,
    originalDueTs: raw.originalDueTs ?? raw.recheckDueTs ?? raw.triggerTs,
    recheckDueTs: raw.recheckDueTs ?? raw.originalDueTs ?? raw.triggerTs,
    attempts: raw.attempts ?? 0,
    initial: {
      total: typeof raw.initialTotal === 'number' ? raw.initialTotal : null,
      e: legacyE,
      holdersDoneTs: raw.triggerTs + (raw.initialOffsetMs ?? 0),
      times: emptyTimes,
    },
  };
}

/** 可中止的 sleep。复核那一觉要睡 5 分钟，用裸 setTimeout 的话退出时会丢任务。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('已中止'));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('已中止')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
