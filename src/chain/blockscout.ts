import { env } from '../config.js';
import { log } from '../logger.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Blockscout 公共实例会限流（返回 {"message":"Too many requests"}）。
 * 简单令牌桶：最多 4 次/秒，串行放行。
 */
const bucket = { tokens: 4, last: Date.now() };
async function throttle(): Promise<void> {
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(4, bucket.tokens + ((now - bucket.last) / 1000) * 4);
    bucket.last = now;
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return; }
    await new Promise(r => setTimeout(r, 120));
  }
}

async function get<T>(path: string): Promise<T | null> {
  await throttle();
  try {
    const res = await fetch(`${env.blockscoutUrl}${path}`, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(6_000),   // 有端点会挂死几十秒，超时必须短
    });
    if (res.status === 429) { log.debug({ path }, 'Blockscout 限流 429'); return null; }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    log.debug({ path, err: String(err) }, 'blockscout 请求失败');
    return null;
  }
}

export interface TokenInfo {
  name: string | null;
  symbol: string | null;
  decimals: string | null;
  total_supply: string | null;
  holders_count: string | null;
  exchange_rate: string | null;
  circulating_market_cap: string | null;
  volume_24h: string | null;
}

export const blockscout = {
  tokenInfo: (ca: string) => get<TokenInfo>(`/api/v2/tokens/${ca}`),

  /**
   * 原生币（ETH）美元价。Blockscout 可能被 Cloudflare 403，所以同时问两个公开现货源；
   * 多个结果差异超过 10% 时拒绝更新，避免单点坏值污染所有成交量。
   */
  ethPrice: (() => {
    let cached = 0;
    let at = 0;
    return async (): Promise<number> => {
      if (Date.now() - at < 60_000 && cached > 0) return cached;
      const external = async (url: string): Promise<any> => {
        try {
          const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(5_000) });
          return r.ok ? await r.json() : null;
        } catch { return null; }
      };
      const [s, coinbase, coingecko] = await Promise.all([
        get<{ coin_price: string }>('/api/v2/stats'),
        external('https://api.coinbase.com/v2/prices/ETH-USD/spot'),
        external('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'),
      ]);
      const prices = [Number(s?.coin_price), Number(coinbase?.data?.amount), Number(coingecko?.ethereum?.usd)]
        .filter(p => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
      if (prices.length >= 2 && prices[prices.length - 1]! / prices[0]! > 1.1) {
        log.warn({ prices }, 'ETH 报价源差异超过 10%，拒绝更新');
        return cached;
      }
      const p = prices.length ? prices[Math.floor(prices.length / 2)]! : 0;
      if (p > 0) { cached = p; at = Date.now(); }
      return cached;
    };
  })(),

  /**
   * 代币的真实部署区块。这一步不能省：这些币是 EIP-1167 克隆（实现合约
   * RobinVistaLaunchToken，工厂 0x4A3e797B…），部署往往远早于建池——
   * 实测 AGI 的池子比部署晚了约 100 分钟。按建池区块去扫 Transfer 会严重漏算持币人。
   * 工厂本身不发事件，所以只能问 Blockscout。结果永久缓存（部署区块不会变）。
   */
  creation: (() => {
    const memo = new Map<string, { block: bigint; ts: number } | null>();
    return async (ca: string): Promise<{ block: bigint; ts: number } | null> => {
      const key = ca.toLowerCase();
      if (memo.has(key)) return memo.get(key)!;
      const r = await get<{ result?: { blockNumber: string; timestamp: string }[] }>(
        `/api?module=contract&action=getcontractcreation&contractaddresses=${ca}`,
      );
      if ((r as any)?.message?.includes('Too many requests')) return null;   // 限流，交给二分回退
      const hit = r?.result?.[0];
      const out = hit ? { block: BigInt(hit.blockNumber), ts: Number(hit.timestamp) * 1000 } : null;
      if (out) memo.set(key, out);
      return out;
    };
  })(),

  /** v2 的地址详情。v1 被限流时这个常常还能通，是取部署交易哈希的备用路。 */
  creationTxHash: async (ca: string): Promise<string | null> => {
    const r = await get<{ creation_transaction_hash?: string }>(`/api/v2/addresses/${ca}`);
    return r?.creation_transaction_hash ?? null;
  },

  /** Blockscout 自己的持币人数——只用来和我们自建的日志重建结果对账。 */
  async holdersCount(ca: string): Promise<number | null> {
    const t = await this.tokenInfo(ca);
    const n = Number(t?.holders_count ?? NaN);
    return Number.isFinite(n) ? n : null;
  },
};
