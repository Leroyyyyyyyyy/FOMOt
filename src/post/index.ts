/**
 * PostEngine：post_v1 的生命周期与调度（设计文档 §4）。
 *
 * 与旧 Engine 完全独立：不加载 FOMO 浏览器、不调 holder/PnL 调度、不读旧
 * pools/swaps 表。共用的只有 RPC 客户端、日志范围自适应和 Telegram 凭据。
 *
 * 一个 tick 的顺序：
 *   采集（原始事件+覆盖）→ 定价补算 → 分层 → K 线聚合 → 形态评估
 *   → 叙事门 → 信号事务 → outbox worker
 * 网络/LLM 一律在事务外；outbox 由独立节拍驱动，受 min_gap_ms 限制。
 */
import { chain } from '../config.js';
import { log } from '../logger.js';
import { client, withRetry } from '../chain/client.js';
import { db, setHealth, recordMetric } from '../db.js';
import { migratePostSchema, prunePost } from './store.js';
import { postConfig, type PostConfig } from './config.js';
import { BlockTimeResolver, scanBlocks, registerSkippedRange, sampleQuotes, repriceAll, poolMeta, coverageWatermark } from './providers/chain.js';
import { retier, firstTradeOf, candidateCounts, type Candidate } from './discovery.js';
import { buildMinuteCandles, rollUp, loadCandles, bucketOpen } from './market/candles.js';
import { loadSwaps } from './market/events.js';
import { createSeries, choosePrimaryPool, detectPriceConflict, getSeries, endSeries } from './market/series.js';
import { evaluateEpisodes, type EvaluationContext } from './run.js';
import { lease, dispatch, recover, offPort, telegramPort, outboxStats, type SendPort } from './outbox.js';
import { notifier } from '../notify/notifier.js';
import type { NotifyMode } from '../notify/notifier.js';
import type { Timeframe } from './types.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface PostEngineOptions {
  runId?: string;
  mode?: NotifyMode;
  /** 回放/演练用：固定时钟。 */
  now?: () => number;
}

export class PostEngine {
  readonly cfg: PostConfig;
  readonly configHash: string;
  private readonly times = new BlockTimeResolver();
  private readonly runId: string;
  private readonly mode: NotifyMode;
  private readonly port: SendPort;
  private readonly now: () => number;
  private lastQuoteSample = 0;
  private lastRetier = 0;
  private lastPrune = 0;
  private lastOutboxSend = 0;
  private cursorBlock: bigint | null = null;

  constructor(opt: PostEngineOptions = {}) {
    migratePostSchema();
    const { config, hash } = postConfig();
    this.cfg = config;
    this.configHash = hash;
    this.runId = opt.runId ?? 'live';
    this.mode = opt.mode ?? notifier.mode;
    // off 模式用本地出口：整条状态机照跑，但绝不产生 Telegram 网络请求。
    this.port = this.mode === 'telegram' ? telegramPort : offPort();
    this.now = opt.now ?? (() => Date.now());
  }

  /** 启动恢复：未终结 episode、采集游标、pending outbox。过时事件只归档。 */
  start(): { outbox: ReturnType<typeof recover>; episodes: number; candidates: Record<string, number> } {
    const r = recover(this.now(), this.runId);
    const episodes = (db.prepare(
      `SELECT COUNT(*) n FROM post_episodes WHERE terminal=0 AND run_id=?`,
    ).get(this.runId) as any).n;
    log.info({
      模式: this.mode, runId: this.runId, configHash: this.configHash,
      回收lease: r.reaped, 归档过期: r.expired, 待发: r.pending, 待人工核对: r.unknown,
      未终结episode: episodes,
    }, 'PostEngine 启动恢复完成');
    if (r.unknown > 0) {
      log.warn({ 待人工核对: r.unknown }, '存在发送结果未知的任务：不会自动重发，可能漏通知（见 npm run post:report）');
    }
    return { outbox: r, episodes, candidates: candidateCounts(chain.id) };
  }

  /** 采集一批区块。返回本次推进到的 block。 */
  async collect(): Promise<{ from: number; to: number; swaps: number; newPools: number; gap: boolean } | null> {
    const latest = await withRetry(() => client.getBlockNumber(), 'post blockNumber');
    const saved = this.cursorBlock ?? readCursor();
    const perHour = 36_000n;   // 只用于判断「落后多少」，不用于算事件时间
    let from: bigint;
    let gap = false;

    if (saved === null) {
      // 首次启动：accumulate 从当前开始；backfill 按 lookback 往回取。
      const back = this.cfg.history.startup_mode === 'backfill'
        ? perHour * BigInt(Math.round(this.cfg.history.lookback_days * 24))
        : 0n;
      from = latest > back ? latest - back : 0n;
      log.info({ 起点: Number(from), 模式: this.cfg.history.startup_mode }, 'post 采集起点');
    } else {
      from = BigInt(saved) + 1n;
    }

    const behind = latest - from;
    const maxBehind = perHour * 2n;
    if (behind > maxBehind) {
      // 旧 watcher 会直接跳过去；post 必须**登记缺口**并调度回补，
      // 缺口没补好之前不得发形态确认（§3）。
      const skipTo = latest - maxBehind;
      await registerSkippedRange(from, skipTo, this.times);
      from = skipTo + 1n;
      gap = true;
    }
    if (from > latest) return null;
    const to = latest - from > 3000n ? from + 3000n : latest;

    const r = await scanBlocks(from, to, this.times, chain.id);
    writeCursor(to);
    this.cursorBlock = to;
    this.times.sweep(Number(from) - 5000);
    setHealth('post_chain_lag_blocks', Number(latest - to));
    return { from: r.fromBlock, to: r.toBlock, swaps: r.swaps, newPools: r.newPools, gap };
  }

  /** 给一个候选聚合 K 线。返回它当前的 seriesId。 */
  aggregate(c: Candidate, watermarkTs: number): string | null {
    const asOf = this.now();
    let seriesId = activeSeriesOf(chain.id, c.ca);
    if (!seriesId) {
      const pick = choosePrimaryPool(chain.id, c.ca, asOf);
      if (!pick.poolId) return null;
      seriesId = createSeries(chain.id, c.ca, pick.poolId, asOf).seriesId;
      log.debug({ ca: c.ca, poolId: pick.poolId, reason: pick.reason }, 'post 冻结主池并建立 series');
    }
    const s = getSeries(seriesId)!;

    // 跨池价格持续背离 → 标冲突并暂停确认，不挑高价池制造突破。
    const conflict = detectPriceConflict(chain.id, c.ca, s.poolId, watermarkTs - 3600_000, watermarkTs,
      this.cfg.market.price_conflict_max);
    if (conflict.conflict) {
      endSeries(seriesId, asOf, `主池价格冲突：${conflict.detail}`);
      log.warn({ ca: c.ca, detail: conflict.detail }, 'post 主池价格冲突，终结 series 并重新预热');
      return null;
    }

    const lookbackMs = Math.max(
      this.cfg.second_leg.ready_max_hours + this.cfg.second_leg.first_leg_max_hours + this.cfg.second_leg.seed_box_hours,
      this.cfg.new_pullback.max_age_hours,
    ) * 3600_000;
    const fromTs = bucketOpen(Math.max(s.startedAt, watermarkTs - lookbackMs), 60);
    const toTs = bucketOpen(watermarkTs, 60) + 60_000;

    const swaps = loadSwaps(s.poolId, fromTs, toTs);
    const opt = { watermarkTs, graceSeconds: this.cfg.scan.closed_bar_grace_seconds, asOf, source: this.times.sourceLabel };
    buildMinuteCandles({ seriesId, chainId: chain.id, ca: c.ca, poolId: s.poolId }, swaps, fromTs, toTs, opt);
    for (const tf of [300, 900, 3600] as Timeframe[]) {
      rollUp({ seriesId, chainId: chain.id, ca: c.ca, poolId: s.poolId }, tf, fromTs, toTs, opt);
    }
    return seriesId;
  }

  /** 跑一轮完整 tick。 */
  async tick(): Promise<void> {
    const t0 = this.now();

    // 1. 报价：每分钟一条，历史换算只认这些当时存下来的。
    if (t0 - this.lastQuoteSample > 60_000) {
      this.lastQuoteSample = t0;
      const ok = await sampleQuotes(t0);
      setHealth('post_quote_source', ok ? 'ok' : 'unavailable');
    }

    // 2. 采集
    const collected = await this.collect();
    if (collected) recordMetric('post_scan_swaps', collected.swaps);

    // 3. 定价补算（报价故障恢复后）
    const rp = repriceAll(chain.id);
    if (rp.repriced) log.debug(rp, 'post 补算历史定价');

    // 4. 分层
    if (t0 - this.lastRetier > 30_000) {
      this.lastRetier = t0;
      const tiers = retier(chain.id, t0, {
        hotLimit: this.cfg.scan.hot_limit,
        warmLimit: this.cfg.scan.warm_limit,
        candidateMaxAgeDays: this.cfg.history.candidate_max_age_days,
        newTokenWindowHours: this.cfg.new_pullback.max_age_hours,
        hotActivityWindowMs: 15 * 60_000,
      });
      setHealth('post_hot', tiers.hot.length);
      setHealth('post_warm', tiers.warm.length);
      setHealth('post_queued_beyond_budget', tiers.queuedBeyondBudget);
      this.tiers = tiers;
    }

    // 5. K 线 + 形态 + 信号
    const wm = coverageWatermark();
    const watermarkTs = wm.ts ?? t0;
    const targets = [...(this.tiers?.hot ?? []), ...(this.tiers?.warm ?? [])];
    let evaluated = 0, signals = 0;
    for (const c of targets) {
      try {
        const seriesId = this.aggregate(c, watermarkTs);
        if (!seriesId) continue;
        const ctx: EvaluationContext = {
          cfg: this.cfg, configHash: this.configHash, chainId: chain.id,
          ca: c.ca, symbol: c.symbol, seriesId,
          firstTradeTs: c.firstTradeTs, ageQuality: c.ageQuality,
          asOf: t0, watermarkTs, mode: this.mode, runId: this.runId,
        };
        const r = evaluateEpisodes(ctx);
        evaluated++;
        signals += r.signals.length;
      } catch (err) {
        log.warn({ ca: c.ca, err: String(err).slice(0, 160) }, 'post 候选评估出错');
      }
    }
    recordMetric('post_evaluated', evaluated);
    if (signals) recordMetric('post_signals', signals);

    // 6. outbox：受 min_gap_ms 限制，紧挨请求再检查期限
    await this.drainOutbox(t0);

    // 7. 维护
    if (t0 - this.lastPrune > 10 * 60_000) {
      this.lastPrune = t0;
      const r = prunePost(t0, {
        rawRetentionDays: this.cfg.history.raw_retention_days,
        candle1mRetentionDays: this.cfg.history.candle_1m_retention_days,
        candleHigherRetentionDays: this.cfg.history.candle_higher_retention_days,
        evidenceRetentionDays: this.cfg.history.evidence_retention_days,
      });
      log.debug({ 清理: r.filter(x => x.deleted > 0) }, 'post 维护完成');
    }
    setHealth('post_tick_ms', this.now() - t0);
    recordMetric('post_tick_ms', this.now() - t0);
  }

  private tiers: ReturnType<typeof retier> | null = null;

  /** 逐条发送。每轮最多发一条，保证 min_gap_ms 真的生效。 */
  async drainOutbox(now: number): Promise<void> {
    if (now - this.lastOutboxSend < this.cfg.notifications.min_gap_ms) return;
    const task = lease(this.mode, now, 30_000, this.runId);
    if (!task) return;
    this.lastOutboxSend = now;
    const r = await dispatch(task, this.port, this.now(), {
      ambiguousPolicy: this.cfg.notifications.ambiguous_send_policy as any,
      runId: this.runId,
    });
    log.info({ outboxId: r.outboxId, state: r.state, detail: r.detail.slice(0, 120) }, 'post outbox');
  }

  stats(): Record<string, unknown> {
    return {
      configHash: this.configHash,
      mode: this.mode,
      候选: candidateCounts(chain.id),
      outbox: outboxStats(this.runId),
      水位: coverageWatermark(),
    };
  }

  /** 主循环。由 src/index.ts 在 STRATEGY_MODE=post_v1 时调用。 */
  async run(signal: AbortSignal): Promise<void> {
    this.start();
    let lastBeat = 0;
    while (!signal.aborted) {
      const t0 = this.now();
      try { await this.tick(); }
      catch (err) { log.error({ err: String(err).slice(0, 200) }, 'post tick 出错'); await sleep(2000); }
      if (t0 - lastBeat > 60_000) {
        lastBeat = t0;
        const mem = process.memoryUsage();
        recordMetric('post_rss_mb', mem.rss / 1048576);
        log.info(this.stats(), 'post 心跳');
      }
      await sleep(Math.max(0, this.cfg.scan.realtime_interval_ms - (this.now() - t0)));
    }
  }
}

// ── 游标 ───────────────────────────────────────────────────────────────────

function readCursor(): string | null {
  const r = db.prepare("SELECT v FROM cursor WHERE k='post_last_block'").get() as any;
  return r?.v ?? null;
}
function writeCursor(to: bigint): void {
  db.prepare("INSERT INTO cursor (k,v) VALUES ('post_last_block', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(to.toString());
}

function activeSeriesOf(chainId: number, ca: string): string | null {
  const r = db.prepare(
    `SELECT series_id FROM post_series WHERE chain_id=? AND ca=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
  ).get(chainId, ca.toLowerCase()) as any;
  return r?.series_id ?? null;
}
