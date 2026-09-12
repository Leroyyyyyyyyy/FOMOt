/**
 * 链上适配器：把现有扫链基础设施接到 post 的数据契约上（设计文档 §3 / §5）。
 *
 * 复用：`client`（多端点降级）、`AdaptiveRange`/`scanRange`（日志上限自适应）、
 * `poolManagerAbi`、`splitPair`/`quoteMeta`、`priceFromSqrtX96`。
 * **不复用** `BlockClock.tsOf`：它按「约 100ms 出块」从一个锚点线性外推，
 * 进程跑几天后误差会累积到分钟级，而 K 线分桶要求真实区块时间（§5.1）。
 */
import type { Address, Log } from 'viem';
import { client, withRetry } from '../../chain/client.js';
import { poolManagerAbi, erc20Abi } from '../../chain/abi.js';
import { chain } from '../../config.js';
import { splitPair, quoteMeta } from '../../chain/quotes.js';
import { blockscout } from '../../chain/blockscout.js';
import { AdaptiveRange, scanRange } from '../../chain/logrange.js';
import { log } from '../../logger.js';
import { db } from '../../db.js';
import '../store.js';
import { ingestSwaps, repriceMissing } from '../market/events.js';
import { recordQuote } from '../market/quotes.js';
import { recordSupply } from '../market/supply.js';
import { recordInterval, recordGap, watermark } from '../market/coverage.js';
import type { PoolMeta, SwapEvent } from '../types.js';

/**
 * 区块时间解析。
 *
 * 每个区块都单独取一次 RPC 太贵（实测 ~6 条 Swap/块、一个 tick 上千块），
 * 所以采用**有测量锚点的插值**：每隔 anchorSpacing 个块取一次真实区块头，
 * 只在相邻两个**已测量**锚点之间插值，绝不跨锚点外推。
 * 落在分钟边界附近（误差带以内）的事件再补一次精确取值，
 * 保证分桶归属是准的。
 *
 * 用了近似就要让它在数据里看得见：K 线 source 写成 `chain:anchored<N>`。
 */
export class BlockTimeResolver {
  private cache = new Map<number, number>();
  constructor(private readonly anchorSpacing = 300) {}

  get sourceLabel(): string { return `chain:anchored${this.anchorSpacing}`; }

  async exact(block: number): Promise<number> {
    const hit = this.cache.get(block);
    if (hit !== undefined) return hit;
    const b = await withRetry(() => client.getBlock({ blockNumber: BigInt(block) }), `getBlock ${block}`, 3);
    const ts = Number(b.timestamp) * 1000;
    this.cache.set(block, ts);
    return ts;
  }

  /** 预取一个范围内的锚点。 */
  async prime(from: number, to: number): Promise<void> {
    const wanted: number[] = [];
    for (let b = from; b <= to; b += this.anchorSpacing) if (!this.cache.has(b)) wanted.push(b);
    if (!this.cache.has(to)) wanted.push(to);
    // 并发 4，避免把 RPC 打满；扫链 tick 的实时预算跟历史回补是分开的。
    for (let i = 0; i < wanted.length; i += 4) {
      await Promise.all(wanted.slice(i, i + 4).map(b => this.exact(b).catch(() => {})));
    }
  }

  /** 插值。相邻锚点之间按**实测**间隔线性分配，不用配置里的 100ms 常量。 */
  private interpolate(block: number): { ts: number; errorMs: number } | null {
    let lo: number | null = null, hi: number | null = null;
    for (const b of this.cache.keys()) {
      if (b <= block && (lo === null || b > lo)) lo = b;
      if (b >= block && (hi === null || b < hi)) hi = b;
    }
    if (lo === null || hi === null) return null;
    if (lo === hi) return { ts: this.cache.get(lo)!, errorMs: 0 };
    const tLo = this.cache.get(lo)!, tHi = this.cache.get(hi)!;
    const per = (tHi - tLo) / (hi - lo);
    const ts = tLo + (block - lo) * per;
    // 误差带：锚点间隔越大、出块越不均匀，误差越大。保守取一个锚点跨度的 10%。
    return { ts, errorMs: Math.max(50, Math.abs(tHi - tLo) * 0.1) };
  }

  /**
   * 解析一批区块的时间。落在分钟边界误差带内的区块补精确取值——
   * 分桶归属错了，K 线就错了。
   */
  async resolve(blocks: number[], bucketMs = 60_000): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const needExact: number[] = [];
    for (const b of new Set(blocks)) {
      const cached = this.cache.get(b);
      if (cached !== undefined) { out.set(b, cached); continue; }
      const est = this.interpolate(b);
      if (!est) { needExact.push(b); continue; }
      const intoBucket = ((est.ts % bucketMs) + bucketMs) % bucketMs;
      if (intoBucket < est.errorMs || bucketMs - intoBucket < est.errorMs) needExact.push(b);
      else out.set(b, Math.round(est.ts));
    }
    for (let i = 0; i < needExact.length; i += 4) {
      await Promise.all(needExact.slice(i, i + 4).map(async b => { out.set(b, await this.exact(b)); }));
    }
    return out;
  }

  /** 缓存无上限会长；扫过的区间不会再回头。 */
  sweep(keepFrom: number): void {
    for (const b of this.cache.keys()) if (b < keepFrom) this.cache.delete(b);
  }
}

// ── 池与代币登记 ───────────────────────────────────────────────────────────

const upsertPool = db.prepare(
  `INSERT INTO post_pools (chain_id, pool_id, ca, quote, quote_symbol, quote_decimals, token_is0,
     token_decimals, fee, hooks, init_block, init_ts)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain_id, pool_id) DO NOTHING`,
);
const upsertToken = db.prepare(
  `INSERT INTO post_tokens (chain_id, ca, symbol, name, decimals, first_seen_at, tier, age_quality, meta_updated_ts)
   VALUES (?,?,?,?,?,?,?,?,?)
   ON CONFLICT(chain_id, ca) DO UPDATE SET symbol=excluded.symbol, name=excluded.name,
     decimals=excluded.decimals, meta_updated_ts=excluded.meta_updated_ts`,
);
const insDiscovery = db.prepare(
  `INSERT INTO post_discoveries (source, source_event_id, chain_id, ca, pool_id, event_ts, observed_at, available_at, evidence_ref)
   VALUES ('chain',?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
);

export function poolMeta(chainId: number, poolId: string): PoolMeta | null {
  const r = db.prepare('SELECT * FROM post_pools WHERE chain_id=? AND pool_id=?').get(chainId, poolId) as any;
  if (!r) return null;
  return {
    chainId: r.chain_id, poolId: r.pool_id, ca: r.ca, quote: r.quote,
    quoteSymbol: r.quote_symbol, quoteDecimals: r.quote_decimals,
    tokenIs0: !!r.token_is0, tokenDecimals: r.token_decimals ?? 18,
  };
}

/** 代币元数据 + 时点供应量快照。供应量必须按时点存，历史 FDV 才算得出来。 */
export async function refreshTokenMeta(chainId: number, ca: Address, atBlock: number, atTs: number): Promise<number | null> {
  try {
    const [symbol, name, decimals, totalSupply] = await Promise.all([
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'totalSupply' }),
    ]);
    const d = Number(decimals);
    upsertToken.run(chainId, ca.toLowerCase(), symbol, name, d, Date.now(), 'warm', 'unknown', Date.now());
    recordSupply(chainId, ca.toLowerCase(), atBlock, totalSupply as bigint, d, atTs, Date.now(), 'rpc:totalSupply');
    return d;
  } catch {
    return null;                     // 非标准 ERC20：元数据未知，不猜
  }
}

export interface InitializeResult { registered: number }

export async function onInitialize(l: Log, times: Map<number, number>, chainId = chain.id): Promise<boolean> {
  const a = (l as any).args;
  const pair = splitPair(a.currency0, a.currency1);
  if (!pair) return false;                                  // 纯币币对，无法计价
  const q = quoteMeta(pair.quote);
  if (!q) return false;
  const poolId = a.id as string;
  const block = Number(l.blockNumber);
  const ts = times.get(block) ?? Date.now();
  const ca = pair.token.toLowerCase();

  const r = upsertPool.run(chainId, poolId, ca, pair.quote, q.symbol, q.decimals,
    pair.tokenIsCurrency0 ? 1 : 0, null, Number(a.fee), a.hooks, block, ts);
  if (Number(r.changes) === 0) return false;

  upsertToken.run(chainId, ca, null, null, null, Date.now(), 'warm', 'unknown', null);
  insDiscovery.run(`init:${poolId}`, chainId, ca, poolId, ts, Date.now(), Date.now(), `Initialize@${block}`);
  const decimals = await refreshTokenMeta(chainId, pair.token, block, ts);
  if (decimals !== null) {
    db.prepare('UPDATE post_pools SET token_decimals=? WHERE chain_id=? AND pool_id=?').run(decimals, chainId, poolId);
  }
  return true;
}

// ── 扫描 ───────────────────────────────────────────────────────────────────

const swapRange = new AdaptiveRange(600n, 25n, 800n, 'post/Swap');
const initRange = new AdaptiveRange(2000n, 100n, 4000n, 'post/Initialize');

async function getLogs(event: unknown, range: AdaptiveRange, from: bigint, to: bigint): Promise<Log[]> {
  return scanRange(range, from, to, async (lo, hi) => {
    const logs = await withRetry(
      () => client.getLogs({ address: chain.poolManager, event: event as any, fromBlock: lo, toBlock: hi }),
      `post getLogs ${(event as any).name} ${lo}-${hi}`, 2,
    );
    return logs as unknown as Log[];
  });
}

export interface ScanResult {
  fromBlock: number; toBlock: number;
  newPools: number; swaps: number; unpriced: number;
  pools: string[];
  sourceLabel: string;
}

/**
 * 扫一段区块并落库。**采集与游标一起提交**（由 ingestSwaps 的事务保证），
 * 定价失败不会逼着丢原始日志。
 */
export async function scanBlocks(
  from: bigint, to: bigint, times: BlockTimeResolver, chainId = chain.id,
): Promise<ScanResult> {
  await times.prime(Number(from), Number(to));
  const [inits, swaps] = await Promise.all([
    getLogs(poolManagerAbi[0], initRange, from, to),
    getLogs(poolManagerAbi[1], swapRange, from, to),
  ]);

  const blockNums = [...inits, ...swaps].map(l => Number(l.blockNumber));
  const tsMap = await times.resolve(blockNums);
  let newPools = 0;
  for (const l of inits) if (await onInitialize(l, tsMap, chainId)) newPools++;

  // 按池分组，逐池入库（每个池的 quote/decimals 不同）
  const byPool = new Map<string, SwapEvent[]>();
  const observedAt = Date.now();
  for (const l of swaps) {
    const a = (l as any).args;
    const poolId = a.id as string;
    const block = Number(l.blockNumber);
    const ts = tsMap.get(block);
    if (ts === undefined) continue;                          // 拿不到真实时间就不入库，绝不猜
    const e: SwapEvent = {
      chainId, poolId, blockNumber: block, blockHash: (l.blockHash ?? '') as string,
      txHash: (l.transactionHash ?? '') as string,
      txIndex: l.transactionIndex ?? 0, logIndex: l.logIndex ?? 0,
      eventTs: ts, observedAt,
      amount0: BigInt(a.amount0), amount1: BigInt(a.amount1), sqrtPriceX96: BigInt(a.sqrtPriceX96),
      liquidity: a.liquidity !== undefined ? BigInt(a.liquidity) : null,
      tick: a.tick !== undefined ? Number(a.tick) : null,
    };
    const arr = byPool.get(poolId);
    if (arr) arr.push(e); else byPool.set(poolId, [e]);
  }

  let ingested = 0, unpriced = 0;
  const touched: string[] = [];
  for (const [poolId, events] of byPool) {
    const meta = poolMeta(chainId, poolId);
    if (!meta) continue;                                     // 不关心的池（非白名单计价）
    const r = ingestSwaps(events, meta);
    ingested += r.inserted;
    unpriced += r.unpriced;
    touched.push(poolId);
  }

  /**
   * 覆盖按**扫过的区块范围**记，而不是按找到的成交时间记——
   * 一次 getLogs 扫的是整个 PoolManager，扫过这段区块就等于扫过了该范围内
   * 所有池，**包括这段时间一笔成交都没有的池**。用成交时间当覆盖范围会让
   * 安静的分钟永远拿不到 complete 覆盖，于是全部退化成 unknown，
   * 「扫描完整的空桶」这种情形就再也出不来了。
   */
  const anchorFrom = tsMap.get(Number(from)) ?? (await times.exact(Number(from)));
  const anchorTo = tsMap.get(Number(to)) ?? (await times.exact(Number(to)));
  recordInterval(chainId, '*', 'realtime', Number(from), Number(to), anchorFrom, anchorTo, 'complete');

  return {
    fromBlock: Number(from), toBlock: Number(to),
    newPools, swaps: ingested, unpriced, pools: touched,
    sourceLabel: times.sourceLabel,
  };
}

/**
 * 缺口登记。watcher 落后超过一小时会跳过一段——post 路径必须**记录**这个区间
 * 并调度回补，缺口没补好之前不得发形态确认（§3）。
 */
export async function registerSkippedRange(from: bigint, to: bigint, times: BlockTimeResolver, chainId = chain.id): Promise<void> {
  const fromTs = await times.exact(Number(from)).catch(() => null);
  const toTs = await times.exact(Number(to)).catch(() => null);
  recordGap(chainId, '*', Number(from), Number(to), fromTs, toTs,
    `实时扫描落后过多，跳过 ${Number(to - from)} 块，已排入回补队列`);
  log.warn({ from: Number(from), to: Number(to) }, 'post 扫描出现缺口，已登记待回补');
}

export function coverageWatermark(chainId = chain.id): { block: number | null; ts: number | null } {
  return watermark(chainId, '*', 'realtime');
}

// ── 报价采集 ───────────────────────────────────────────────────────────────

/**
 * 每分钟留一条 ETH 报价。历史换算只能用这些**当时就存下来的**报价；
 * 本地覆盖之外的历史一律 missing，不用当前价回算（§5.3）。
 */
export async function sampleQuotes(now = Date.now()): Promise<boolean> {
  try {
    const usd = await blockscout.ethPrice();
    if (!(usd > 0)) return false;
    // quote_ts 对齐到分钟，availableAt 是真正拿到的时刻。
    recordQuote({ source: 'blockscout+external', asset: 'ETH', quoteTs: Math.floor(now / 60_000) * 60_000,
      usd, availableAt: now, quality: 'live' });
    return true;
  } catch {
    return false;
  }
}

/** 报价恢复后补算之前定不了价的成交。 */
export function repriceAll(chainId = chain.id, limitPerPool = 2000): { pools: number; repriced: number; stillMissing: number } {
  const pools = db.prepare(
    `SELECT DISTINCT pool_id FROM post_swaps WHERE chain_id=? AND quote_quality='missing' LIMIT 200`,
  ).all(chainId) as any[];
  let repriced = 0, stillMissing = 0;
  for (const p of pools) {
    const meta = poolMeta(chainId, p.pool_id);
    if (!meta) continue;
    const r = repriceMissing(meta, limitPerPool);
    repriced += r.repriced;
    stillMissing += r.stillMissing;
  }
  return { pools: pools.length, repriced, stillMissing };
}
