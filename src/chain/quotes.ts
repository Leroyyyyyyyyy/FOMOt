import type { Address } from 'viem';
import { blockscout } from './blockscout.js';

export const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/**
 * 计价资产白名单。样本 196 个新池里：NATIVE 66 次、USDG 47 次、WETH 5 次，
 * 其余高频 currency（AI/AGI/TSLA/RDDT…）都是币币对，不作计价。
 */
const QUOTES: Record<string, { symbol: string; decimals: number; usd: 'eth' | 'one' }> = {
  [ZERO]: { symbol: 'ETH', decimals: 18, usd: 'eth' },
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': { symbol: 'WETH', decimals: 18, usd: 'eth' },
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', decimals: 6, usd: 'one' },
};

export interface QuoteAsset { address: Address; symbol: string; decimals: number; usdPrice: number }
const priceCache = new Map<string, { price: number; at: number }>();

export function isQuote(addr: Address): boolean {
  return addr.toLowerCase() in QUOTES;
}

/** 计价资产的静态信息（不含价格）。价格必须每次现取，见 resolveQuote 的说明。 */
export function quoteMeta(addr: Address): { symbol: string; decimals: number } | null {
  const q = QUOTES[addr.toLowerCase()];
  return q ? { symbol: q.symbol, decimals: q.decimals } : null;
}

/**
 * 解析计价资产 + 它当前的美元价。
 *
 * 拿不到价格时返回 **null**，绝不能返回 usdPrice: 0。
 * blockscout.ethPrice() 在首次成功之前返回 0（Blockscout 会限流），
 * 以前这个 0 会被原样传出去、再被 poolCache 永久缓存，于是那个池子
 * 之后每笔成交都算成 $0——既不入库也不更新价，池子静默变成死池，
 * 而健康行还显示 chain_source: ok。
 */
export async function resolveQuote(addr: Address): Promise<QuoteAsset | null> {
  const q = QUOTES[addr.toLowerCase()];
  if (!q) return null;
  const usdPrice = q.usd === 'one' ? 1 : await blockscout.ethPrice();
  if (!(usdPrice > 0)) return null;
  priceCache.set(addr.toLowerCase(), { price: usdPrice, at: Date.now() });
  return { address: addr, symbol: q.symbol, decimals: q.decimals, usdPrice };
}

/** 热路径只读报价缓存，避免候选扫描被 Blockscout 网络请求串行阻塞。 */
export function resolveQuoteCached(addr: Address, maxAgeMs = 120_000): QuoteAsset | null {
  const q = QUOTES[addr.toLowerCase()];
  if (!q) return null;
  if (q.usd === 'one') return { address: addr, symbol: q.symbol, decimals: q.decimals, usdPrice: 1 };
  const hit = priceCache.get(addr.toLowerCase());
  if (!hit || Date.now() - hit.at > maxAgeMs) return null;
  return { address: addr, symbol: q.symbol, decimals: q.decimals, usdPrice: hit.price };
}

/**
 * 从一个 V4 池的两个 currency 里分出「目标代币」和「计价资产」。
 * 两边都不是计价资产（纯币币对）时返回 null —— 这类池不推送。
 */
export function splitPair(currency0: Address, currency1: Address):
  { token: Address; quote: Address; tokenIsCurrency0: boolean } | null {
  const q0 = isQuote(currency0), q1 = isQuote(currency1);
  if (q0 === q1) return null;                       // 两个都是或都不是 → 跳过
  return q1
    ? { token: currency0, quote: currency1, tokenIsCurrency0: true }
    : { token: currency1, quote: currency0, tokenIsCurrency0: false };
}
