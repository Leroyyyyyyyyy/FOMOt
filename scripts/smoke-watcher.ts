import { watchChain } from '../src/chain/watcher.js';
import { activeTokens, volumeUsd } from '../src/chain/volume.js';
import { db, getHealth } from '../src/db.js';

const ac = new AbortController();
const run = watchChain(ac.signal);
setTimeout(() => ac.abort(), 45_000);
await Promise.race([run, new Promise(r => setTimeout(r, 46_000))]);

const pools = (db.prepare('SELECT COUNT(*) n FROM pools').get() as any).n;
const swaps = (db.prepare('SELECT COUNT(*) n FROM swaps').get() as any).n;
console.log(`\n=== 45 秒扫描结果 ===`);
console.log(`池 ${pools} 个 · Swap ${swaps} 条 · 落后 ${getHealth('chain_lag_blocks')?.value} 块 · tick ${getHealth('chain_tick_ms')?.value}ms`);
console.log(`\n最活跃的代币（5 分钟窗口）:`);
for (const t of activeTokens(5 * 60_000, 8)) {
  const meta = db.prepare('SELECT symbol FROM tokens WHERE ca = ?').get(t.ca) as any;
  console.log(`  ${(meta?.symbol ?? '?').padEnd(12)} ${t.ca}  5m=$${volumeUsd(t.ca, 300_000).toFixed(0).padStart(8)}  ${t.swaps} 笔`);
}
process.exit(0);
