import type { Address } from 'viem';
import { db } from '../db.js';
import { tokenMeta, tokenMetaCached, type TokenMeta } from './watcher.js';
import { resolveQuote, resolveQuoteCached, type QuoteAsset } from './quotes.js';
import { priceUsd, marketCapUsd } from './pricing.js';
import { volumeUsd, swapCount } from './volume.js';

export interface Market {
  ca: string; symbol: string; name: string; decimals: number;
  priceUsd: number; marketCapUsd: number;
  volume5m: number; volume1h: number; swaps5m: number;
  poolAgeMs: number;
}

/** 取最近 5 分钟成交额最大的池，避免新建空池或小额操纵池覆盖主池价格。 */
const bestPool = db.prepare(`
  SELECT p.pool_id, p.quote, p.token_is0, p.init_ts, s.sqrt, s.ts
  FROM pools p JOIN pool_state s ON s.pool_id = p.pool_id
  JOIN swaps v ON v.pool_id = p.pool_id
  WHERE p.ca = ? AND s.has_swap = 1 AND v.ts >= ?
  GROUP BY p.pool_id
  ORDER BY SUM(v.usd) DESC, s.ts DESC LIMIT 1
`);

function build(ca: string, row: any, meta: TokenMeta, quote: QuoteAsset): Market {
  const p = priceUsd(BigInt(row.sqrt), meta.decimals, quote.decimals, !!row.token_is0, quote.usdPrice);
  return {
    ca: ca.toLowerCase(), symbol: meta.symbol, name: meta.name, decimals: meta.decimals,
    priceUsd: p, marketCapUsd: marketCapUsd(p, meta.totalSupply, meta.decimals),
    volume5m: volumeUsd(ca, 5 * 60_000), volume1h: volumeUsd(ca, 60 * 60_000),
    swaps5m: swapCount(ca, 5 * 60_000), poolAgeMs: Date.now() - Number(row.init_ts),
  };
}

export async function snapshotMarket(ca: string): Promise<Market | null> {
  const row = bestPool.get(ca.toLowerCase(), Date.now() - 5 * 60_000) as any;
  if (!row) return null;
  const meta = await tokenMeta(ca as Address);
  if (!meta) return null;
  const quote = await resolveQuote(row.quote);
  return quote ? build(ca, row, meta, quote) : null;
}

/** 引擎候选扫描专用：只读 SQLite 和内存报价缓存。 */
export function snapshotMarketCached(ca: string): Market | null {
  const row = bestPool.get(ca.toLowerCase(), Date.now() - 5 * 60_000) as any;
  if (!row) return null;
  const meta = tokenMetaCached(ca as Address);
  const quote = resolveQuoteCached(row.quote);
  return meta && quote ? build(ca, row, meta, quote) : null;
}
