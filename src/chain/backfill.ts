import { client, blockClock, withRetry } from './client.js';
import { poolManagerAbi } from './abi.js';
import { chain, rules } from '../config.js';
import { db } from '../db.js';
import { splitPair, quoteMeta } from './quotes.js';
import { log } from '../logger.js';

const upsertPool = db.prepare(
  `INSERT OR IGNORE INTO pools (pool_id, ca, quote, token_is0, fee, hooks, init_block, init_ts) VALUES (?,?,?,?,?,?,?,?)`,
);
const upsertPoolState = db.prepare(
  `INSERT INTO pool_state (pool_id, sqrt, ts, has_swap) VALUES (?,?,?,0) ON CONFLICT(pool_id) DO NOTHING`,
);

/**
 * 启动时把候选窗口内的建池事件补齐。
 *
 * 不补的话，冷启动后只认识刚扫到的那几个池，已有代币的 Swap 全被当成未知池丢掉，
 * 成交量会严重偏低。Initialize 很稀疏（约 0.024 条/块），4000 块一批很轻松。
 */
export async function backfillPools(): Promise<number> {
  const latest = await blockClock.sync();
  const blocks = BigInt(Math.ceil((rules.universe.max_age_minutes * 60_000) / chain.blockTimeMs));
  const from = latest > blocks ? latest - blocks : 0n;
  const CHUNK = 4000n;
  let found = 0;

  log.info({ from: Number(from), to: Number(latest), 分钟: rules.universe.max_age_minutes }, '回补建池事件…');
  for (let lo = from; lo <= latest; lo += CHUNK) {
    const hi = lo + CHUNK - 1n > latest ? latest : lo + CHUNK - 1n;
    const logs = await withRetry(
      () => client.getLogs({ address: chain.poolManager, event: poolManagerAbi[0], fromBlock: lo, toBlock: hi }),
      `回补 ${lo}-${hi}`,
    );
    for (const l of logs) {
      const a = l.args as any;
      const pair = splitPair(a.currency0, a.currency1);
      if (!pair) continue;
      if (!quoteMeta(pair.quote)) continue;
      const ts = blockClock.tsOf(l.blockNumber!);
      upsertPool.run(a.id, pair.token.toLowerCase(), pair.quote, pair.tokenIsCurrency0 ? 1 : 0, Number(a.fee), a.hooks, Number(l.blockNumber), ts);
      upsertPoolState.run(a.id, String(a.sqrtPriceX96), ts);
      found++;
    }
  }
  log.info({ pools: found }, '回补完成');
  return found;
}
