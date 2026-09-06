import { client, withRetry } from './client.js';
import { blockscout } from './blockscout.js';
import { db } from '../db.js';
import { log } from '../logger.js';

export interface Deployment { block: bigint; ts: number }

const memo = new Map<string, Deployment>();      // 进程内缓存
const negative = new Map<string, number>();      // 查不到的先冷却，别每个 tick 都重试

const readRow = db.prepare('SELECT block, ts FROM token_deployment WHERE ca = ?');
const writeRow = db.prepare(
  `INSERT INTO token_deployment (ca, block, ts, updated_ts) VALUES (?,?,?,?)
   ON CONFLICT(ca) DO UPDATE SET block = excluded.block, ts = excluded.ts, updated_ts = excluded.updated_ts`,
);

/** 只读缓存（内存 + SQLite），绝不发网络请求。触发路径必须走这个。 */
export function deploymentCached(ca: string): Deployment | null {
  const key = ca.toLowerCase();
  const hit = memo.get(key);
  if (hit) return hit;
  const row = readRow.get(key) as { block: number; ts: number } | undefined;
  if (!row) return null;
  const out = { block: BigInt(row.block), ts: row.ts };
  memo.set(key, out);
  return out;
}

/** 负缓存过期就扔掉；memo 给个上限防失控（持久化那份在 SQLite 里）。 */
export function sweepDeployment(): void {
  const now = Date.now();
  for (const [k, t] of negative) if (now - t > 60_000) negative.delete(k);
  if (memo.size > 20_000) memo.clear();
}

const DEADLINE_MS = 9_000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms).unref())]);
}

/**
 * 代币部署区块和时间。
 *
 * 为什么必须查：这些币是 EIP-1167 克隆（实现合约 RobinVistaLaunchToken），
 * 部署往往远早于建池——实测 AGI 的池子比部署晚约 100 分钟。按建池区块去扫
 * Transfer 会把持币人数算少一大截（127 vs 实际 639）。
 *
 * 为什么不能用 eth_getCode 二分：公共 RPC 不是归档节点，往回 1000 块还行，
 * 10 万块就报错；二分会把「查询失败」当成「尚未部署」，静默返回偏晚的区块——
 * 实测某个币因此少算了 87% 的持币人。静默给错答案比直接失败更糟。
 *
 * 为什么整体加了超时上限：Blockscout 的 v1 creation 接口会 429，
 * v2 addresses 接口实测会挂死约 50 秒。这一步曾经拖到 +54.6s 才出快照，
 * 而卡片上写的是「+0.8s」。结果一律持久化，同一个币只会付一次这个代价。
 */
export async function deployment(ca: string): Promise<Deployment | null> {
  const key = ca.toLowerCase();
  const cached = deploymentCached(key);
  if (cached) return cached;

  const cooling = negative.get(key);
  if (cooling && Date.now() - cooling < 60_000) return null;

  const found = await withDeadline(resolve(ca), DEADLINE_MS);
  if (found) {
    memo.set(key, found);
    writeRow.run(key, Number(found.block), found.ts, Date.now());
    return found;
  }
  negative.set(key, Date.now());
  return null;
}

async function resolve(ca: string): Promise<Deployment | null> {
  // 路线 1：一次调用就拿到区块和时间戳
  const direct = await blockscout.creation(ca);
  if (direct) return direct;

  // 路线 2：v1 被限流时，从部署交易哈希反推。历史交易和区块都能查（被裁剪的只有 state）。
  try {
    const hash = await blockscout.creationTxHash(ca);
    if (!hash) return null;
    const tx = await withRetry(() => client.getTransaction({ hash: hash as `0x${string}` }), 'getTransaction', 2);
    if (tx.blockNumber == null) return null;
    const blk = await withRetry(() => client.getBlock({ blockNumber: tx.blockNumber! }), 'getBlock', 2);
    return { block: tx.blockNumber, ts: Number(blk.timestamp) * 1000 };
  } catch (err) {
    log.debug({ ca, err: String(err).slice(0, 120) }, '解析部署区块失败');
    return null;
  }
}
