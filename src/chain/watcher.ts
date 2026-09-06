import type { Address, Log } from 'viem';
import { client, blockClock, withRetry } from './client.js';
import { poolManagerAbi, erc20Abi } from './abi.js';
import { chain, rules } from '../config.js';
import { db, getCursor, setCursor, setHealth, pruneSwaps } from '../db.js';
import { splitPair, resolveQuote, quoteMeta } from './quotes.js';
import { recordSwap, swapUsd } from './volume.js';
import { log } from '../logger.js';
import { AdaptiveRange, scanRange } from './logrange.js';

/**
 * 注意这里**不缓存计价资产的美元价**。以前缓存了，结果两个问题：
 * 池子一旦加载，ETH 价就冻结在那一刻（进程跑几天后成交量全按旧价算）；
 * 更糟的是 Blockscout 限流窗口里加载的池子会被缓存成 quoteUsd: 0，永久失效。
 * 价格改成每笔成交现取——resolveQuote 内部有 60 秒缓存，开销可以忽略。
 */
interface PoolRow { poolId: string; ca: string; quote: Address; tokenIs0: boolean; quoteDecimals: number }
const poolCache = new Map<string, PoolRow | null>();     // null = 已知但不关心的池

const upsertPool = db.prepare(
  `INSERT OR IGNORE INTO pools (pool_id, ca, quote, token_is0, fee, hooks, init_block, init_ts) VALUES (?,?,?,?,?,?,?,?)`,
);
const upsertToken = db.prepare(
  `INSERT INTO tokens (ca, symbol, name, decimals, total_supply, updated_ts) VALUES (?,?,?,?,?,?)
   ON CONFLICT(ca) DO UPDATE SET symbol=excluded.symbol, name=excluded.name,
     decimals=excluded.decimals, total_supply=excluded.total_supply, updated_ts=excluded.updated_ts`,
);
const upsertPoolState = db.prepare(
  `INSERT INTO pool_state (pool_id, sqrt, ts, has_swap) VALUES (?,?,?,?)
   ON CONFLICT(pool_id) DO UPDATE SET sqrt=excluded.sqrt, ts=excluded.ts,
     has_swap=MAX(pool_state.has_swap, excluded.has_swap)
     WHERE excluded.ts >= pool_state.ts`,   // 追赶回放时别用历史价盖掉当前价
);

export interface TokenMeta { ca: string; symbol: string; name: string; decimals: number; totalSupply: bigint }

export function tokenMetaCached(ca: Address): TokenMeta | null {
  const row = db.prepare('SELECT * FROM tokens WHERE ca = ?').get(ca.toLowerCase()) as any;
  return row ? { ca: row.ca, symbol: row.symbol, name: row.name, decimals: row.decimals, totalSupply: BigInt(row.total_supply) } : null;
}

export async function tokenMeta(ca: Address): Promise<TokenMeta | null> {
  const row = db.prepare('SELECT * FROM tokens WHERE ca = ?').get(ca.toLowerCase()) as any;
  if (row && Date.now() - row.updated_ts < 3600_000) {
    return { ca: row.ca, symbol: row.symbol, name: row.name, decimals: row.decimals, totalSupply: BigInt(row.total_supply) };
  }
  try {
    const [symbol, name, decimals, totalSupply] = await Promise.all([
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'totalSupply' }),
    ]);
    const meta = { ca: ca.toLowerCase(), symbol, name, decimals: Number(decimals), totalSupply };
    upsertToken.run(meta.ca, symbol, name, meta.decimals, totalSupply.toString(), Date.now());
    return meta;
  } catch {
    return null;                                          // 非标准 ERC20
  }
}

async function loadPool(poolId: string): Promise<PoolRow | null> {
  if (poolCache.has(poolId)) return poolCache.get(poolId)!;
  const row = db.prepare('SELECT * FROM pools WHERE pool_id = ?').get(poolId) as any;
  if (!row) { poolCache.set(poolId, null); return null; }
  // 只缓存静态信息（是不是白名单计价资产、几位小数），价格不缓存
  const meta = quoteMeta(row.quote);
  const p = meta ? { poolId, ca: row.ca, quote: row.quote, tokenIs0: !!row.token_is0, quoteDecimals: meta.decimals } : null;
  poolCache.set(poolId, p);
  return p;
}

async function onInitialize(l: Log): Promise<void> {
  const a = (l as any).args;
  const pair = splitPair(a.currency0, a.currency1);
  if (!pair) return;                                      // 纯币币对，无法计价
  const quote = quoteMeta(pair.quote);
  if (!quote) return;

  const poolId = a.id as string;
  const ts = blockClock.tsOf(l.blockNumber!);
  const inserted = upsertPool.run(poolId, pair.token.toLowerCase(), pair.quote, pair.tokenIsCurrency0 ? 1 : 0, Number(a.fee), a.hooks, Number(l.blockNumber), ts);
  upsertPoolState.run(poolId, String(a.sqrtPriceX96), ts, 0);
  poolCache.delete(poolId);

  // 一小时回放会再次见到已有池；静态行没变化时无需重复 RPC 拉元数据或刷日志。
  if (Number(inserted.changes) === 0) return;

  const meta = await tokenMeta(pair.token);
  log.info({ token: meta?.symbol ?? '?', quote: quote.symbol, ca: pair.token }, '发现新池');
}

async function onSwap(l: Log): Promise<void> {
  const a = (l as any).args;
  const pool = await loadPool(a.id as string);
  if (!pool) return;
  const ts = blockClock.tsOf(l.blockNumber!);

  // 价格更新要先做，且不能被「这笔成交算不出美元额」连带跳过——
  // 否则 snapshotMarket 会一直拿着过期价算市值。
  upsertPoolState.run(pool.poolId, String(a.sqrtPriceX96), ts, 1);

  const quote = await resolveQuote(pool.quote);
  if (!quote) {
    setHealth('quote_price', 'unavailable');
    // 不能推进游标后静默丢掉成交；整批失败后会从原游标幂等重放。
    throw new Error(`报价不可用 ${pool.quote}`);
  }
  setHealth('quote_price', 'ok');
  const usd = swapUsd(a.amount0, a.amount1, pool.tokenIs0, pool.quoteDecimals, quote.usdPrice);
  if (usd <= 0) return;
  recordSwap(pool.poolId, l.blockNumber!, l.logIndex ?? 0, ts, usd);
}

// 实测日志密度：Swap 约 5.2 条/块（800 块 = 8407 条，1600 块超限），Initialize 约 0.024 条/块。
// 两个事件密度差 200 倍，各自维护范围，别共用。
/** 1h 成交量门要求至少有一整个连续窗口，冷启动或长断线都回放最近一小时。 */
const ONE_HOUR_BLOCKS = 36_000n;

const swapRange = new AdaptiveRange(600n, 25n, 800n, 'Swap');
const initRange = new AdaptiveRange(2000n, 100n, 4000n, 'Initialize');

async function getLogsAdaptive(event: unknown, range: AdaptiveRange, from: bigint, to: bigint): Promise<Log[]> {
  return scanRange(range, from, to, async (lo, hi) => {
    const logs = await withRetry(
      () => client.getLogs({ address: chain.poolManager, event: event as any, fromBlock: lo, toBlock: hi }),
      `getLogs ${(event as any).name} ${lo}-${hi}`, 2,
    );
    return logs as unknown as Log[];
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** poolCache 会给「见过但不关心」的池子也留一条 null，随时间无上限增长。 */
export function sweepPools(): void {
  if (poolCache.size < 50_000) return;
  // pools 表本身会裁剪；整张缓存清空后按需从 SQLite 重建，避免有效旧项也永久驻留。
  poolCache.clear();
}

export async function watchChain(signal: AbortSignal): Promise<void> {
  let lastPrune = 0;
  let coverageStart = getCursor('volume_coverage_start');
  while (!signal.aborted) {
    const t0 = Date.now();
    try {
      const latest = await withRetry(() => blockClock.sync(), 'blockNumber');
      const saved = getCursor('last_block');
      let from: bigint;
      if (!saved || !coverageStart) {
        from = latest > ONE_HOUR_BLOCKS ? latest - ONE_HOUR_BLOCKS : 0n;
        coverageStart = from.toString();
        setCursor('volume_coverage_start', coverageStart);
        setHealth('volume_window_complete', 'false');
      } else {
        from = BigInt(saved) + 1n;
      }

      /**
       * 落后太多（重启时游标过期、或断网很久）就直接跳过去，别老实回放。
       * 那些旧成交早就掉出 5m/1h 窗口了，回放纯属浪费——实测落后 11 分钟时
       * 一个 tick 要处理 6.5 万条 Swap、耗时 28 秒，几分钟内候选集都是空的。
       */
      const behind = latest - from;
      if (behind > ONE_HOUR_BLOCKS) {
        from = latest > ONE_HOUR_BLOCKS ? latest - ONE_HOUR_BLOCKS : 0n;
        coverageStart = from.toString();
        setCursor('volume_coverage_start', coverageStart);
        setHealth('volume_window_complete', 'false');
        log.warn({ 落后区块: Number(behind), 回放起点: Number(from) }, '落后超过一小时，重建完整成交量窗口');
      }
      if (from > latest) { await sleep(200); continue; }
      const to = latest - from > 6000n ? from + 6000n : latest;   // 单 tick 推进上限

      const [inits, swaps] = await Promise.all([
        getLogsAdaptive(poolManagerAbi[0], initRange, from, to),
        getLogsAdaptive(poolManagerAbi[1], swapRange, from, to),
      ]);
      for (const l of inits) await onInitialize(l);
      for (const l of swaps) await onSwap(l);

      setCursor('last_block', to.toString());
      setHealth('chain_source', 'ok');
      setHealth('chain_lag_blocks', Number(latest - to));
      setHealth('chain_tick_ms', Date.now() - t0);
      setHealth('chain_last_batch', `${inits.length} init / ${swaps.length} swap`);
      const complete = to >= latest && to - BigInt(coverageStart) >= ONE_HOUR_BLOCKS;
      setHealth('volume_window_complete', complete ? 'true' : 'false');

      if (Date.now() - lastPrune > 300_000) { pruneSwaps(); lastPrune = Date.now(); }
    } catch (err) {
      setHealth('chain_source', 'error');
      log.warn({ err: String(err).slice(0, 180) }, '扫链出错，退避重试');
      await sleep(2000);
    }
    await sleep(Math.max(0, rules.scan.interval_ms - (Date.now() - t0)));
  }
}
