import { parseAbiItem, type Address } from 'viem';
import { client, withRetry, blockClock } from './client.js';
import { chain } from '../config.js';
import { ZERO } from './quotes.js';
import { log } from '../logger.js';
import { AdaptiveRange, scanRange } from './logrange.js';

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** 这些地址不是「人」：池子、销毁地址、代币合约自身。 */
const INFRA = new Set<string>([ZERO.toLowerCase(), chain.poolManager.toLowerCase(), '0x000000000000000000000000000000000000dead']);

export interface HolderSnapshot {
  ca: Address;
  total: number;                                   // 全链持币人数（余额 > 0）
  top: { address: Address; balance: bigint }[];     // 已剔除基础设施地址
  /** 只读余额表。**每次返回都是独立副本**，后续更新不会改动已经发出去的快照。 */
  balances: ReadonlyMap<string, bigint>;
  atBlock: bigint;
  atBlockHash: string | null;
  /** 链上区块时间（毫秒） */
  blockTs: number | null;
  /** 这份快照的采集完成时间（毫秒），与链上时间分开 */
  takenTs: number;
  scannedBlocks: number;
  /** 本次是否放弃增量、从部署区块全量重建 */
  rebuilt: boolean;
  latencyMs: number;
}

interface TransferDelta { block: bigint; from: string; to: string; value: bigint }
interface CacheEntry {
  balances: Map<string, bigint>;
  lastBlock: bigint;
  /** 最近 REORG_DEPTH 个区块的哈希，用来证明连续性 */
  hashes: Map<string, string>;
  touched: number;
  recent: TransferDelta[];
}
const cache = new Map<string, CacheEntry>();
const REORG_DEPTH = 64n;

/** 同一个 CA 的更新必须串行——Engine 的全局并发上限管不住「两个任务同时改同一张表」。 */
const chainLocks = new Map<string, Promise<unknown>>();
function withCaLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chainLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // 锁链本身要吞掉异常，否则一次失败会让这个 CA 之后的排队全被拒。
  // Map 的清理交给 sweepHolders / forgetHolders，跟余额表缓存同生命周期。
  chainLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

function applyTransfer(balances: Map<string, bigint>, d: TransferDelta, direction: 1 | -1): void {
  const value = direction === 1 ? d.value : -d.value;
  if (d.from !== ZERO.toLowerCase()) balances.set(d.from, (balances.get(d.from) ?? 0n) - value);
  balances.set(d.to, (balances.get(d.to) ?? 0n) + value);
}

export class ReorgTooDeepError extends Error {
  constructor(readonly ca: string, readonly depth: bigint) {
    super(`${ca} 的重组深度超出 ${REORG_DEPTH} 区块回放窗口`);
    this.name = 'ReorgTooDeepError';
  }
}

/** 可注入的链上取数接口，测试用 mock 替换，不碰实时主网。 */
export interface ChainReader {
  getLogs(ca: Address, from: bigint, to: bigint): Promise<{ blockNumber: bigint | null; args: unknown }[]>;
  getBlockHash(block: bigint): Promise<string | null>;
  /** 哈希与时间戳一次取回。热路径上不能为同一个区块发两次 RPC。 */
  getBlockMeta(block: bigint): Promise<{ hash: string | null; ts: number | null }>;
}

export const liveReader: ChainReader = {
  async getLogs(ca, from, to) {
    const range = new AdaptiveRange(5_000n, 50n, 20_000n, `Transfer ${ca}`);
    return scanRange(range, from, to, (lo, hi) =>
      withRetry(() => client.getLogs({ address: ca, event: transferEvent, fromBlock: lo, toBlock: hi }),
        `Transfer 日志 ${ca} ${lo}-${hi}`, 2)) as Promise<any>;
  },
  async getBlockHash(block) {
    const cached = blockClock.metaFor(block);
    if (cached) return cached.hash;
    const b = await withRetry(() => client.getBlock({ blockNumber: block }), `区块 ${block}`, 2).catch(() => null);
    return b?.hash ?? null;
  },
  async getBlockMeta(block) {
    // 绝大多数快照的 toBlock 就是刚 sync 回来的那个最新块，这里直接命中，零 RPC。
    const cached = blockClock.metaFor(block);
    if (cached) return cached;
    const b = await withRetry(() => client.getBlock({ blockNumber: block }), `区块 ${block}`, 2).catch(() => null);
    return { hash: b?.hash ?? null, ts: b ? Number(b.timestamp) * 1000 : null };
  },
};

/**
 * 用代币自己的 Transfer 日志重建余额表。
 *
 * 关键约束（以前都不成立）：
 *  1. 回滚与重放全在**临时状态**上做，整轮成功后才原子替换缓存。
 *     以前是先在共享 Map 上撤销最近区块、再去发网络请求，请求失败缓存就已经坏了，
 *     重试还会把同一批 delta 再撤一次。
 *  2. 同一 CA 串行，不靠调用方的并发上限。
 *  3. 返回的快照持有独立副本，后续更新改不到它。
 *  4. 用区块哈希验证连续性；超出回放深度就**重建**，绝不假装支持任意重组。
 */
export function snapshotHolders(
  ca: Address, fromBlock: bigint, toBlock: bigint, topN = 10, reader: ChainReader = liveReader,
): Promise<HolderSnapshot> {
  return withCaLock(ca.toLowerCase(), () => snapshotHoldersLocked(ca, fromBlock, toBlock, topN, reader));
}

async function snapshotHoldersLocked(
  ca: Address, fromBlock: bigint, toBlock: bigint, topN: number, reader: ChainReader,
): Promise<HolderSnapshot> {
  const t0 = Date.now();
  const key = ca.toLowerCase();
  let cached = cache.get(key);
  let rebuilt = false;

  // ── 连续性检查 ────────────────────────────────────────────────
  // head 倒退或同高度换分支都要在这里发现。判据是区块哈希，不是高度。
  if (cached) {
    const anchor = cached.lastBlock < toBlock ? cached.lastBlock : toBlock;
    if (anchor < cached.lastBlock - REORG_DEPTH + 1n) {
      // 倒退超过回放窗口，缓存里没有能撤销的 delta 了
      log.warn({ ca, from: cached.lastBlock, to: toBlock }, 'head 倒退超出回放窗口，重建余额表');
      cached = undefined; rebuilt = true;
    } else {
      const known = cached.hashes.get(String(anchor));
      if (known) {
        const actual = await reader.getBlockHash(anchor);
        if (actual && actual !== known) {
          // anchor 处就已经换了分支；能不能救取决于分叉点是否落在回放窗口内
          const floor = cached.lastBlock - REORG_DEPTH + 1n;
          const floorHash = cached.hashes.get(String(floor));
          const floorActual = floor >= 0n ? await reader.getBlockHash(floor) : null;
          if (floorHash && floorActual && floorHash !== floorActual) {
            log.warn({ ca, floor }, '重组深度超出回放窗口，重建余额表');
            cached = undefined; rebuilt = true;
          } else {
            log.info({ ca, anchor }, '检测到重组，将回放最近区块');
          }
        }
      }
    }
  }

  // ── 在临时状态上回滚 + 重放 ───────────────────────────────────
  const balances = new Map(cached?.balances ?? []);
  const overlapFloor = cached ? cached.lastBlock - REORG_DEPTH + 1n : fromBlock;
  const start = cached ? (overlapFloor > fromBlock ? overlapFloor : fromBlock) : fromBlock;
  const kept = cached?.recent.filter(d => d.block < start) ?? [];
  if (cached) {
    for (let i = cached.recent.length - 1; i >= 0; i--) {
      const d = cached.recent[i]!;
      if (d.block >= start) applyTransfer(balances, d, -1);
    }
  }

  let scanned = 0;
  const freshHashes = new Map(cached?.hashes ?? []);
  if (start <= toBlock) {
    // 这一步失败会直接抛出。**共享缓存至今没有被动过**，所以重试等价于从头再来一次。
    const logs = await reader.getLogs(ca, start, toBlock);
    const fetched: TransferDelta[] = [];
    for (const l of logs) {
      const { from, to, value } = l.args as { from: Address; to: Address; value: bigint };
      const d = { block: l.blockNumber!, from: from.toLowerCase(), to: to.toLowerCase(), value };
      applyTransfer(balances, d, 1);
      fetched.push(d);
    }
    scanned = Number(toBlock - start + 1n);
    kept.push(...fetched.filter(d => d.block >= toBlock - REORG_DEPTH + 1n));
  }

  // 记录新的连续性锚点。取不到哈希不算失败——只是下一轮少一份证据。
  // 哈希和区块时间一次取回，避免在 +0.8s 关键路径上为同一个区块发两次 RPC。
  const tipMeta = await reader.getBlockMeta(toBlock).catch(() => ({ hash: null, ts: null }));
  const tipHash = tipMeta.hash;
  if (tipHash) freshHashes.set(String(toBlock), tipHash);
  for (const k of freshHashes.keys()) {
    if (BigInt(k) < toBlock - REORG_DEPTH) freshHashes.delete(k);
  }

  // ── 全部成功，原子替换 ────────────────────────────────────────
  cache.set(key, { balances, lastBlock: toBlock, hashes: freshHashes, touched: Date.now(), recent: kept });

  let total = 0;
  const holders: { address: Address; balance: bigint }[] = [];
  for (const [addr, bal] of balances) {
    if (bal <= 0n) continue;
    total++;
    if (!INFRA.has(addr) && addr !== key) holders.push({ address: addr as Address, balance: bal });
  }
  holders.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  const snap: HolderSnapshot = {
    ca, total, top: holders.slice(0, topN),
    // 独立副本：后续 snapshotHolders 会往 cache 里换新 Map，但这份不会变。
    balances: new Map(balances),
    atBlock: toBlock, atBlockHash: tipHash,
    blockTs: tipMeta.ts,
    takenTs: Date.now(),
    scannedBlocks: scanned, rebuilt,
    latencyMs: Date.now() - t0,
  };
  log.debug({ ca, total, scanned, rebuilt, ms: snap.latencyMs }, '持币快照');
  return snap;
}

/**
 * 按空闲时间清理余额表缓存。
 *
 * 每个代币一张 Map，热门币有几千个地址，全都常驻内存；链上每天新增约 1 万个币，
 * 不清的话这是这个进程最大的一处泄漏。
 */
export function sweepHolders(maxIdleMs: number): number {
  const cutoff = Date.now() - maxIdleMs;
  let dropped = 0;
  for (const [k, v] of cache) if (v.touched < cutoff) { cache.delete(k); chainLocks.delete(k); dropped++; }
  return dropped;
}

/** 余额表是否已建好。没建好就去做「+0.8s 快照」，实际要等几十秒——那个标签就成了假话。 */
export function isWarm(ca: string): boolean {
  return cache.has(ca.toLowerCase());
}

export function forgetHolders(ca: Address): void {
  cache.delete(ca.toLowerCase());
  chainLocks.delete(ca.toLowerCase());
}
export function trackedTokens(): number {
  return cache.size;
}
/** 测试用：清空全部缓存状态。 */
export function resetHolderCache(): void {
  cache.clear(); chainLocks.clear();
}
