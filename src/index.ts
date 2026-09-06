import { env, rules, validateRules } from './config.js';
import { log } from './logger.js';
import { watchChain, sweepPools } from './chain/watcher.js';
import { sweepHolders, trackedTokens } from './chain/holders.js';
import { sweepDeployment } from './chain/deployment.js';
import { backfillPools } from './chain/backfill.js';
import { Engine } from './engine/index.js';
import { nullFomo, type FomoProvider } from './fomo/provider.js';
import { db, setHealth, getHealth, pruneAll, migratedWalletCandidates, recordMetric, markStartupWindow } from './db.js';
import { notifier } from './notify/notifier.js';
import { linkCounts } from './engine/wallets.js';

async function loadFomo(): Promise<FomoProvider> {
  try {
    const { createFomoProvider } = await import('./fomo/scraper.js');
    return await createFomoProvider();
  } catch (err) {
    log.warn({ err: String(err).slice(0, 160) }, 'FOMO 抓取不可用，降级为纯链上模式（跑 `npm run login` 登录）');
    return nullFomo;
  }
}

async function main(): Promise<void> {
  const ac = new AbortController();
  let shuttingDown = false;
  const shutdown = async (fomo?: FomoProvider) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('收到退出信号，停止中…');
    ac.abort();                      // 唤醒所有在睡的复核；pending 状态保留，供下次启动恢复
    await fomo?.close?.().catch(() => {});   // 不关浏览器会在 profile 里留下 SingletonLock
    setTimeout(() => process.exit(0), 1500).unref();
  };

  const ruleErrors = validateRules();
  if (ruleErrors.length) throw new Error(`规则配置无效: ${ruleErrors.join('; ')}`);
  // 通知模式必须在启动时说清楚。off = 全链路禁发送，不会有任何 Telegram 网络操作。
  log.info({
    通知模式: notifier.mode === 'off' ? 'off（禁发送，只进本地记录器）' : 'telegram（会真的发消息）',
    凭据: env.telegramEnabled ? '已配置' : '未配置',
  }, 'FOMOt 启动');
  if (migratedWalletCandidates) log.info({ 迁移条数: migratedWalletCandidates }, '历史金额推断映射已迁移为未验证候选');
  log.info(linkCounts(), '钱包映射状态');
  let backfillReady = false;
  try { await backfillPools(); backfillReady = true; setHealth('pool_backfill', 'ok'); }
  catch (err) {
    setHealth('pool_backfill', 'error');
    log.warn({ err: String(err).slice(0, 180) }, '启动回补失败，实时扫描继续，触发暂缓');
  }

  const fomo = await loadFomo();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(fomo));
  log.info({ fomo: fomo.ready ? '已就绪' : '不可用（链上模式）' }, 'FOMO 数据源');
  const engine = new Engine(fomo, ac.signal, notifier);

  void watchChain(ac.signal);
  if (!backfillReady) void (async () => {
    while (!ac.signal.aborted) {
      await new Promise(r => setTimeout(r, 60_000));
      try {
        await backfillPools();
        setHealth('pool_backfill', 'ok');
        log.info('建池回补重试成功，解除触发暂缓');
        return;
      } catch (err) {
        setHealth('pool_backfill', 'error');
        log.warn({ err: String(err).slice(0, 140) }, '建池回补重试失败');
      }
    }
  })();
  markStartupWindow(120_000);            // 前两分钟算「启动恢复」，指标分开统计
  const r = engine.resumePending();
  if (r.resumed || r.orphanFiring || r.corrupt || r.pnlResumed) {
    log.info({ 待复核: r.resumed, 遗留firing: r.orphanFiring, 损坏payload: r.corrupt, 待补收益: r.pnlResumed },
      '启动恢复完成');
  }

  let lastBeat = 0, lastMaint = Date.now();
  while (!ac.signal.aborted) {
    const t0 = Date.now();
    try {
      await engine.tick();
      setHealth('engine_tick_ms', Date.now() - t0);
      recordMetric('scan_tick_ms', Date.now() - t0);
      // 维护：清过期内存条目 + 清各表。以前只有 swaps 一张表有清理。
      if (t0 - lastMaint > 5 * 60_000) {
        lastMaint = t0;
        engine.sweep();
        sweepDeployment();
        sweepPools();
        const dropped = sweepHolders(Math.max(30, rules.universe.max_age_minutes) * 60_000);
        try { pruneAll(); } catch (err) { log.warn({ err: String(err).slice(0, 140) }, '清表失败'); }
        log.debug({ 释放持币缓存: dropped }, '维护完成');
      }
      if (t0 - lastBeat > 60_000) {
        lastBeat = t0;
        const mem = process.memoryUsage();
        recordMetric('rss_mb', mem.rss / 1048576);
        recordMetric('heap_mb', mem.heapUsed / 1048576);
        recordMetric('tracked_tokens', trackedTokens());
        recordMetric('chain_lag_blocks', Number(getHealth('chain_lag_blocks')?.value ?? 0));
        const unfinished = (db.prepare(
          "SELECT COUNT(*) n FROM alerts WHERE status IN ('firing','pending_recheck')").get() as any).n;
        recordMetric('unfinished_alerts', unfinished);
        // 排队深度也要有数：长尾到底是排队还是采集慢，验收报告要能分开说。
        const q = engine.queueDepth();
        recordMetric('holder_queue_pending', q.holders.pending);
        recordMetric('holder_active', q.holders.active);
        recordMetric('pnl_tasks_active', q.pnlTasks);
        const n = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n;
        log.info({
          候选: getHealth('universe_size')?.value,
          待预热: getHealth('engine_not_warm')?.value, 可触发: getHealth('engine_eligible')?.value,
          池: n('pools'), 告警: n('alerts'),
          落后区块: getHealth('chain_lag_blocks')?.value, 扫链: `${getHealth('chain_tick_ms')?.value}ms`,
          fomo: fomo.ready ? '在线' : '离线',
          通知: notifier.mode,
        }, '心跳');
      }
    } catch (err) {
      log.error({ err: String(err).slice(0, 200) }, '引擎 tick 出错');
    }
    await new Promise(r => setTimeout(r, Math.max(0, rules.scan.interval_ms - (Date.now() - t0))));
  }
}

main().catch(err => { log.fatal({ err: String(err) }, '启动失败'); process.exit(1); });
