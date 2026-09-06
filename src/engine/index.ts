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
import { renderCard, renderButtons, type AlertData } from '../notify/render.js';
import { enrichSocial, emptyEnriched, type Enriched, type PlatformPnl } from './enrich.js';
import { chainRejection, initialGate, recheckGate } from './rules.js';
import { confirmedWallets, recordAmountCandidates } from './wallets.js';
import type { FomoProvider } from '../fomo/provider.js';
import { HolderScheduler } from './scheduler.js';

const recentAlert = db.prepare("SELECT trigger_ts FROM alerts WHERE ca = ? AND trigger_ts > ? AND status != 'abandoned' LIMIT 1");
const insertAlert = db.prepare(
  `INSERT OR IGNORE INTO alerts (ca, trigger_ts, message_id, payload, status, recheck_due_ts, original_due_ts, attempts, firing_ts, notify_mode, collection_state, last_error)
   VALUES (?,?,NULL,NULL,'firing',?,?,0,?,?,'pending',NULL)`,
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
  `UPDATE alerts SET status=?, collection_state=?, recheck_due_ts=NULL, last_error=?
   WHERE ca=? AND trigger_ts=? AND status='pending_recheck'`,
);
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

interface StoredAlert {
  m: Market;
  triggerTs: number;
  initialTotal: number;
  initE: Enriched;
  initialOffsetMs: number;
  messageId: number | null;
  /** 原始到期时间，永远不被重试覆盖 */
  originalDueTs: number;
  /** 下一次重试时间 */
  recheckDueTs: number;
  attempts: number;
}

/** 快照门拒绝后的冷却时长。够短，让条件变化的币还有机会；够长，不至于每秒空转。 */
const REJECT_COOLDOWN_MS = 90_000;
const RECHECK_RETRY_MS = 60_000;
/** 复核的重试期限：超过原定到期时间这么久还采不全，就终结为「降级」，不再无限重试。 */
const RECHECK_DEADLINE_MS = 15 * 60_000;

export class Engine {
  private prewarmAt = new Map<string, number>();
  private inflight = 0;
  private firing = new Set<string>();
  /** 已经接管过的 (ca, triggerTs)，防止重复恢复同一条任务 */
  private resumed = new Set<string>();
  private readonly holders$: HolderScheduler<HolderSnapshot>;
  private rejectedUntil = new Map<string, number>();

  constructor(
    private readonly fomo: FomoProvider,
    private readonly signal?: AbortSignal,
    private readonly notify: Notifier = notifier,
  ) {
    this.holders$ = new HolderScheduler<HolderSnapshot>(2, signal);
  }

  /**
   * 重启后的恢复。要处理四种历史遗留：
   *   1. 正常的 pending_recheck（有 payload）；
   *   2. 异常退出留下的 firing——卡可能已经发出去了（发送成功、状态未落库的崩溃窗口），
   *      靠本地通知记录判断，不能一律当没发过；
   *   3. 损坏的 payload；
   *   4. 重复恢复（同一条被接管两次）。
   */
  resumePending(): { resumed: number; orphanFiring: number; corrupt: number } {
    let corrupt = 0, orphanFiring = 0, resumed = 0;

    for (const row of db.prepare(
      `SELECT ca, trigger_ts, message_id FROM alerts WHERE status='firing'`).all() as any[]) {
      const sent = findSentMessage.get(row.ca, row.trigger_ts) as { message_id: number } | undefined;
      orphanFiring++;
      if (sent) {
        // 卡片确实发出去了，只是状态没来得及落库。保留记录并标成降级，等人来看。
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
      const key = `${row.ca}|${row.trigger_ts}`;
      if (this.resumed.has(key)) continue;                    // 重复恢复：忽略
      if (row.payload === null) {
        corrupt++;
        abandonAlert.run('pending_recheck 但没有 payload，无法恢复', row.ca, row.trigger_ts);
        continue;
      }
      let state: StoredAlert;
      try {
        state = JSON.parse(row.payload) as StoredAlert;
        if (!state?.m?.ca || typeof state.triggerTs !== 'number') throw new Error('payload 结构不完整');
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
      void this.runRecheck(state).catch(err =>
        log.error({ ca: state.m.ca, err: String(err).slice(0, 180) }, '恢复的复核任务异常退出'));
    }
    return { resumed, orphanFiring, corrupt };
  }

  sweep(): void {
    const now = Date.now();
    for (const [k, t] of this.prewarmAt) if (now - t > 30 * 60_000) this.prewarmAt.delete(k);
    for (const [k, t] of this.rejectedUntil) if (now > t) this.rejectedUntil.delete(k);
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
      const initial = await this.holders(m.ca, 'initial');
      const initEnriched = await this.enrich(m, initial);
      const initialTakenTs = Date.now();
      const initialOffsetMs = initialTakenTs - triggerTs;
      insertSnap.run(m.ca, triggerTs, 'initial', initialTakenTs, initial?.total ?? null, initEnriched.fomoHolders,
        JSON.stringify(stageTimestamps(initial, initEnriched)));
      recordMetric('initial_latency_ms', initialOffsetMs, m.ca);
      if (initial?.blockTs) recordMetric('age_chain_ms', initialTakenTs - initial.blockTs, m.ca);
      if (initEnriched.fomoTakenTs) recordMetric('age_fomo_ms', initialTakenTs - initEnriched.fomoTakenTs, m.ca);
      if (initEnriched.boardTakenTs) recordMetric('age_board_ms', initialTakenTs - initEnriched.boardTakenTs, m.ca);

      const gate = initialGate(initial?.total ?? null, initEnriched, rules.filters);
      if (gate.kind !== 'pass') {
        deleteAlert.run(m.ca, triggerTs);
        this.rejectedUntil.set(m.ca, Date.now() + REJECT_COOLDOWN_MS);
        log.info({ symbol: m.symbol, 原因: gate.reason, 类型: gate.kind }, '快照门未通过，不推送');
        return;
      }

      const data = await this.buildCard(m, triggerTs, initial, initEnriched, initialOffsetMs, null, null, 0);
      const sent = await this.notify.send(renderCard(data), renderButtons(m.ca), { ca: m.ca, triggerTs });
      if (!sent) throw new Error('通知发送失败，未取得 message_id');

      const state: StoredAlert = {
        m, triggerTs, initialTotal: initial!.total, initE: initEnriched,
        initialOffsetMs, messageId: sent.messageId, originalDueTs, recheckDueTs: originalDueTs, attempts: 0,
      };
      setAlertPending.run(sent.messageId, JSON.stringify(state), originalDueTs, m.ca, triggerTs);
      pending = true;
      this.resumed.add(`${m.ca}|${triggerTs}`);
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
          log.warn({ ca: m.ca, attempts: state.attempts }, '复核超出重试期限，终结为降级状态');
          return;
        }
      }
    } finally { this.firing.delete(m.ca); }
  }

  /** 返回 'done' = 这条告警已终结（完成或撤回）；'retry' = 数据不全，需要再来一次。 */
  private async attemptRecheck(state: StoredAlert): Promise<'done' | 'retry'> {
    const { m, triggerTs } = state;
    const recheck = await this.holders(m.ca, 'recheck');
    const reEnriched = await this.enrich(m, recheck, 2_000, 'recheck');
    const recheckTakenTs = Date.now();
    const recheckOffsetMs = recheckTakenTs - triggerTs;
    insertSnap.run(m.ca, triggerTs, 'recheck', recheckTakenTs, recheck?.total ?? null, reEnriched.fomoHolders,
      JSON.stringify(stageTimestamps(recheck, reEnriched)));
    // 复核延迟量的是「相对**原定**到期时间」，不是相对上一次重试
    recordMetric('recheck_lateness_ms', recheckTakenTs - state.originalDueTs, m.ca);
    recordMetric('recheck_attempts', state.attempts, m.ca);

    const gate = recheckGate(recheck?.total ?? null, reEnriched, rules.filters);

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
      this.rejectedUntil.set(m.ca, Date.now() + REJECT_COOLDOWN_MS);
      log.info({ symbol: m.symbol, 原因: gate.reason }, '复核门未通过，已撤回');
      return 'done';
    }

    const m2 = snapshotMarketCached(m.ca) ?? m;
    const data2 = await this.buildCard(m2, triggerTs, { total: state.initialTotal }, state.initE,
      state.initialOffsetMs, recheck, reEnriched, recheckOffsetMs);
    if (state.messageId !== null) {
      const edited = await this.notify.edit(state.messageId, renderCard(data2), renderButtons(m.ca), { ca: m.ca, triggerTs });
      if (!edited) throw new Error('改写失败');
    }
    // 规则通过 ≠ 数据齐全。可选数据缺失时如实记成 degraded，而不是 complete。
    const complete = reEnriched.available && reEnriched.leaderboardAvailable && recheck !== null;
    setAlertDone.run('completed', complete ? 'complete' : 'degraded',
      complete ? null : '规则通过但部分可选数据缺失', m.ca, triggerTs);
    return 'done';
  }

  private scheduleRetry(state: StoredAlert, reason: string): void {
    state.attempts++;
    recordMetric('recheck_retry', 1, `${state.m.ca} ${reason.slice(0, 60)}`);
    // 原定到期时间保留在 originalDueTs，重试只改 recheckDueTs。
    state.recheckDueTs = Date.now() + RECHECK_RETRY_MS;
    setRetry.run(state.recheckDueTs, reason.slice(0, 180), state.m.ca, state.triggerTs);
  }

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
    const wallets = confirmedWallets();

    let platform = new Map<string, PlatformPnl>();
    /**
     * 全平台 24H 收益要为 Top10 每个人单独逛一次档案页，实测约 **71 秒**。
     * 初值那 800ms 的预算绝对放不下——开在初值路径上实测把初值从 1.7s 拖到 1m11s。
     * 只在**复核**阶段取：那里有 5 分钟预算，卡片随后原地改写。
     *
     * 这也和原版一致：原版截图里那行标的是「Top10持币账户（+5m1s）」，
     * +5m1s 是复核阶段的偏移，说明原版同样是在复核阶段算这个数的。
     */
    if (this.fomo.platformPnl24h && priority === 'recheck') {
      const ids = stats.top.slice(0, 10).flatMap(h => h.userId ? [h.userId] : []);
      try { platform = await this.fomo.platformPnl24h(ids); }
      catch (err) { log.debug({ err: String(err).slice(0, 120) }, '取全平台 24H 收益失败，该字段留 n/a'); }
    }
    // 榜单自带的 pnl24h 就是实时口径的全平台 24H 收益，可以直接用。
    for (const b of currentBoard) {
      if (b.userId && !platform.has(b.userId)) platform.set(b.userId, { value: b.pnl24h, window: 'live', asOfTs: b.updatedTs });
    }
    return enrichSocial(m.decimals, snap, stats, currentBoard, boardFresh, wallets, platform);
  }

  private async buildCard(
    m: Market, triggerTs: number,
    initial: { total: number } | null, initE: Enriched, initialOffsetMs: number,
    recheck: HolderSnapshot | null, reE: Enriched | null, recheckOffsetMs: number,
  ): Promise<AlertData> {
    const latestE = reE ?? initE;
    return {
      ca: m.ca, symbol: m.symbol, name: m.name,
      marketCapUsd: m.marketCapUsd, triggerTs,
      volume5m: m.volume5m, volume1h: m.volume1h,
      initial: initial ? { total: initial.total, fomo: initE.fomoHolders, offsetMs: initialOffsetMs } : null,
      recheck: recheck ? { total: recheck.total, fomo: (reE ?? initE).fomoHolders, offsetMs: recheckOffsetMs } : null,
      leaderboardHolders: latestE.leaders,
      leaderboardAvailable: latestE.leaderboardAvailable,
      // 身份覆盖不全 → 交集只能说「已确认至少 N 人」
      leaderboardPartial: latestE.fomoHolders !== null && latestE.identityCoverage < latestE.fomoHolders,
      top10: {
        tokenPnlTotal: latestE.top10TokenPnl,
        tokenPnlCovered: latestE.top10TokenPnlCovered,
        tokenProfitable: latestE.top10TokenProfitable,
        platformPnl24h: latestE.top10PlatformPnl24h,
        platformCovered: latestE.top10PlatformCovered,
        platformWindow: latestE.top10PlatformWindow,
        identified: latestE.identified,
        // 实际集合大小，不再拿另一个集合的人数回填
        count: latestE.top10Count,
        offsetMs: recheck ? recheckOffsetMs : initialOffsetMs,
      },
      health: {
        sourceOk: this.sourcesHealthy(latestE),
        holderCoverage: latestE.fomoHolders !== null ? [latestE.identityCoverage, latestE.fomoHolders] : null,
        ingestMs: latestE.ingestMs,
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
 * 各来源的时间分开存，不再把它们取最小值揉成一个 `fomoTakenTs`。
 * 数据年龄要能分别追溯到链上区块、FOMO 响应、榜单和聚合完成。
 */
function stageTimestamps(snap: HolderSnapshot | null, e: Enriched) {
  return {
    chainBlock: snap ? String(snap.atBlock) : null,
    chainBlockTs: snap?.blockTs ?? null,
    chainTakenTs: snap?.takenTs ?? null,
    fomoTakenTs: e.fomoTakenTs,
    boardTakenTs: e.boardTakenTs,
    aggregatedTs: e.aggregatedTs,
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
