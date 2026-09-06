import { createPublicClient, defineChain, http, fallback } from 'viem';
import { env, chain as cfg } from '../config.js';
import { setHealth } from '../db.js';
import { isLogLimitError } from './logrange.js';
import { log } from '../logger.js';

export const robinhoodChain = defineChain({
  id: cfg.id,
  name: cfg.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [env.rpcUrl] } },
  blockExplorers: { default: { name: 'Blockscout', url: cfg.explorer } },
  contracts: { multicall3: { address: '0xca11bde05977b3631167028862be2a173976ca11' } },
});

/**
 * 多端点降级。**不开 rank**：viem 的 rank 会按延迟自动重排，
 * 但延迟低的节点不一定数据全（实测有些只服务最近 20 个区块），
 * 排序权只能由我们自己按数据完整性决定，不能交给延迟。
 * 严格按 env.rpcUrls 的顺序，前面的报错才降级到后面。
 */
let activeRpc = '';
export function currentRpc(): string { return activeRpc; }

export const client = createPublicClient({
  chain: robinhoodChain,
  transport: fallback(
    env.rpcUrls.map(url =>
      http(url, {
        // getLogs 响应可能有数 MB。把并发的持币复核合成一个 HTTP batch 会越过
        // undici 的 10MB 响应上限，并让整批任务一起失败；每个 RPC 必须独立发送。
        batch: false,
        // 单端点不重试：主端点在负载下会持续劣化，重试 2 次等于每个请求先白等 3 个
        // 失败往返再降级——实测把扫链 tick 从 0.7s 拖到 5.8s。
        // 让降级立刻发生，跨端点的重试交给下面 fallback 层的 retryCount。
        retryCount: 0,
        timeout: 12_000,
        onFetchRequest() {
          if (activeRpc !== url) {
            activeRpc = url;
            setHealth('rpc_endpoint', new URL(url).host);
            if (url !== env.rpcUrls[0]) log.warn({ 端点: new URL(url).host }, 'RPC 已降级到备用端点');
            else log.info({ 端点: new URL(url).host }, 'RPC 使用主端点');
          }
        },
      }),
    ),
    {
      retryCount: 2,   // 跨端点重试：一轮走完两个端点还失败才真的抛错
      /**
       * 「单次命中日志过多」不是端点故障，是**我们的查询太大**，不该降级。
       *
       * 备用端点没有这个 10000 条上限，会把这类查询照单全收——于是
       * AdaptiveRange 永远看不到限流错误、范围只涨不缩，每个请求都必然先在
       * 主端点失败一次。实测：3 分钟里降级 56 次，扫链 tick 从 0.7s 涨到 10s。
       * 备用端点在掩盖我们自己的 bug。这里让它直接抛出，交给自适应逻辑缩范围。
       */
      shouldThrow: isLogLimitError,
    },
  ),
});

/**
 * 100ms 出块下，给每条日志单独取 block 太贵。用最近锚点线性插值——
 * 一个轮询批次跨度不到 1 秒，对 5m/1h 成交量窗口来说误差可忽略。
 */
class BlockClock {
  private anchorBlock = 0n;
  private anchorTs = 0;
  /**
   * sync() 已经把最新区块整个取回来了，哈希和时间戳就在里面。
   * 持币快照紧接着还要用这两样——不缓存的话就是在 +0.8s 的关键路径上
   * 为同一个区块再发两次 RPC。
   */
  private lastMeta: { block: bigint; hash: string | null; ts: number } | null = null;

  async sync(): Promise<bigint> {
    const b = await client.getBlock({ blockTag: 'latest' });
    this.anchorBlock = b.number;
    this.anchorTs = Number(b.timestamp) * 1000;
    this.lastMeta = { block: b.number, hash: b.hash ?? null, ts: this.anchorTs };
    return b.number;
  }

  /** 刚刚 sync 过的那个区块的元数据；不是同一个区块就返回 null，由调用方自己去取。 */
  metaFor(block: bigint): { hash: string | null; ts: number } | null {
    return this.lastMeta && this.lastMeta.block === block
      ? { hash: this.lastMeta.hash, ts: this.lastMeta.ts } : null;
  }
  tsOf(block: bigint): number {
    if (!this.anchorBlock) return Date.now();
    return this.anchorTs + Number(block - this.anchorBlock) * cfg.blockTimeMs;
  }
}
export const blockClock = new BlockClock();

/** 公共 RPC 会偶发抽风（实测扫大范围日志时会返回畸形响应）。指数退避重试。 */
export async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 250 * 2 ** i));
    }
  }
  throw new Error(`${label} 重试 ${attempts} 次仍失败: ${String(last).slice(0, 200)}`);
}
