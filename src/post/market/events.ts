/**
 * 原始 Swap 事件的规范化入库与定价（设计文档 §5.2）。
 *
 * 采集与定价是**两个独立的 durable 阶段**：
 *   采集：原始事件 + 本批游标一起提交。报价挂了也不会逼着丢日志。
 *   定价：单独扫 quote_quality='missing' 的行补算，成功才算「可聚合」。
 * 只有两个阶段都完成的区间才能推进「策略可用水位」。
 */
import { db } from '../../db.js';
import '../store.js';                 // 副作用：确保 post_* 表已建好（顶层 db.prepare 依赖它）
import { priceFromSqrtX96 } from '../../chain/pricing.js';
import { quoteAt, pegQuote } from './quotes.js';
import type { PoolMeta, SwapEvent, QuoteQuality } from '../types.js';
import { compareChainOrder } from '../types.js';

const insertSwap = db.prepare(
  `INSERT INTO post_swaps (chain_id, block_hash, tx_hash, log_idx, pool_id, block_number, tx_index,
     event_ts, observed_at, amount0, amount1, sqrt_price_x96, liquidity, tick,
     token_price_quote, quote_id, price_usd, volume_usd, quote_quality)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(chain_id, block_hash, tx_hash, log_idx) DO NOTHING`,
);

/**
 * 一笔 Swap 的成交额：**只算 quote 侧一边的绝对值**。
 * 两边相加会把同一笔成交算两次（§14 定价用例）。
 */
export function quoteSideUsd(amount0: bigint, amount1: bigint, tokenIs0: boolean, quoteDecimals: number, quoteUsd: number): number {
  const q = tokenIs0 ? amount1 : amount0;
  const abs = q < 0n ? -q : q;
  return (Number(abs) / 10 ** quoteDecimals) * quoteUsd;
}

/** 该 Swap 的**成交后池价**（以计价币计）。统一口径并固定，与外部平台的成交均价 K 可能有差异。 */
export function postSwapPrice(e: SwapEvent, pool: PoolMeta): number {
  const [d0, d1] = pool.tokenIs0
    ? [pool.tokenDecimals, pool.quoteDecimals]
    : [pool.quoteDecimals, pool.tokenDecimals];
  return priceFromSqrtX96(e.sqrtPriceX96, d0, d1, pool.tokenIs0);
}

export interface PricedSwap {
  priceQuote: number;
  priceUsd: number | null;
  volumeUsd: number | null;
  quoteId: string | null;
  quoteQuality: QuoteQuality;
  reason: string;
}

/**
 * 给一笔成交定价。`asOf` 传回放截断时间，保证回测不会提前拿到后来补齐的报价。
 * 拿不到合规报价时返回 quoteQuality='missing'，价格与成交额均为 null——
 * 绝不用 0 代替「不知道」。
 */
export function priceSwap(e: SwapEvent, pool: PoolMeta, asOf?: number): PricedSwap {
  const priceQuote = postSwapPrice(e, pool);
  const q = pool.quoteSymbol === 'USDG' ? pegQuote(pool.quoteSymbol, e.eventTs) : quoteAt(pool.quoteSymbol, e.eventTs, asOf);
  if (q.usd === null) {
    return { priceQuote, priceUsd: null, volumeUsd: null, quoteId: null, quoteQuality: 'missing', reason: q.reason };
  }
  return {
    priceQuote,
    priceUsd: priceQuote * q.usd,
    volumeUsd: quoteSideUsd(e.amount0, e.amount1, pool.tokenIs0, pool.quoteDecimals, q.usd),
    quoteId: q.quoteId,
    quoteQuality: q.quality,
    reason: q.reason,
  };
}

/**
 * 幂等入库一批事件。返回新插入条数。
 *
 * 乱序/重复回放安全：主键是 (chain_id, block_hash, tx_hash, log_idx)，
 * 用 block_hash 而不是 block_number，重组后同一高度的新链事件是另一行，不会互相覆盖。
 */
export function ingestSwaps(events: SwapEvent[], pool: PoolMeta, asOf?: number): { inserted: number; unpriced: number } {
  let inserted = 0, unpriced = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of [...events].sort(compareChainOrder)) {
      const p = priceSwap(e, pool, asOf);
      if (p.quoteQuality === 'missing') unpriced++;
      const r = insertSwap.run(
        e.chainId, e.blockHash, e.txHash, e.logIndex, e.poolId, e.blockNumber, e.txIndex,
        e.eventTs, e.observedAt, e.amount0.toString(), e.amount1.toString(), e.sqrtPriceX96.toString(),
        e.liquidity?.toString() ?? null, e.tick ?? null,
        p.priceQuote, p.quoteId, p.priceUsd, p.volumeUsd, p.quoteQuality,
      );
      inserted += Number(r.changes);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { inserted, unpriced };
}

/**
 * 补算之前定不了价的成交。报价 provider 恢复后调用；
 * 这一步单独有自己的 durable 状态，不与采集游标混为一谈。
 */
export function repriceMissing(pool: PoolMeta, limit = 5000, asOf?: number): { repriced: number; stillMissing: number } {
  const rows = db.prepare(
    `SELECT * FROM post_swaps WHERE pool_id = ? AND quote_quality = 'missing' ORDER BY event_ts LIMIT ?`,
  ).all(pool.poolId, limit) as any[];
  const upd = db.prepare(
    `UPDATE post_swaps SET price_usd=?, volume_usd=?, quote_id=?, quote_quality=?
     WHERE chain_id=? AND block_hash=? AND tx_hash=? AND log_idx=?`,
  );
  let repriced = 0, stillMissing = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      const e: SwapEvent = {
        chainId: r.chain_id, poolId: r.pool_id, blockNumber: r.block_number, blockHash: r.block_hash,
        txHash: r.tx_hash, txIndex: r.tx_index, logIndex: r.log_idx, eventTs: r.event_ts,
        observedAt: r.observed_at, amount0: BigInt(r.amount0), amount1: BigInt(r.amount1),
        sqrtPriceX96: BigInt(r.sqrt_price_x96),
      };
      const p = priceSwap(e, pool, asOf);
      if (p.quoteQuality === 'missing') { stillMissing++; continue; }
      upd.run(p.priceUsd, p.volumeUsd, p.quoteId, p.quoteQuality, r.chain_id, r.block_hash, r.tx_hash, r.log_idx);
      repriced++;
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { repriced, stillMissing };
}

export function loadSwaps(poolId: string, fromTs: number, toTs: number): (SwapEvent & { priceUsd: number | null; volumeUsd: number | null; quoteQuality: QuoteQuality })[] {
  const rows = db.prepare(
    `SELECT * FROM post_swaps WHERE pool_id=? AND event_ts >= ? AND event_ts < ?
     ORDER BY block_number, tx_index, log_idx`,
  ).all(poolId, fromTs, toTs) as any[];
  return rows.map(r => ({
    chainId: r.chain_id, poolId: r.pool_id, blockNumber: r.block_number, blockHash: r.block_hash,
    txHash: r.tx_hash, txIndex: r.tx_index, logIndex: r.log_idx, eventTs: r.event_ts, observedAt: r.observed_at,
    amount0: BigInt(r.amount0), amount1: BigInt(r.amount1), sqrtPriceX96: BigInt(r.sqrt_price_x96),
    priceUsd: r.price_usd, volumeUsd: r.volume_usd, quoteQuality: r.quote_quality as QuoteQuality,
  }));
}

/**
 * 重组处理：某个 block_hash 已经不在规范链上，回滚它带来的所有事件。
 * 不是删掉了事，受影响的 K 线和信号要另行标 data_corrected 修订（§5.3）。
 */
export function rollbackBlock(chainId: number, blockHash: string): number {
  const r = db.prepare('DELETE FROM post_swaps WHERE chain_id=? AND block_hash=?').run(chainId, blockHash);
  return Number(r.changes);
}
