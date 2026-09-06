import { client, blockClock, withRetry } from '../src/chain/client.js';
import { poolManagerAbi } from '../src/chain/abi.js';
import { chain } from '../src/config.js';

const latest = await blockClock.sync();
for (const [name, ev] of [['Initialize', poolManagerAbi[0]], ['Swap', poolManagerAbi[1]]] as const) {
  for (const r of [200n, 400n, 800n, 1600n]) {
    const t0 = Date.now();
    try {
      const logs = await client.getLogs({ address: chain.poolManager, event: ev as any, fromBlock: latest - r, toBlock: latest });
      console.log(`✅ ${name.padEnd(11)} range=${String(r).padStart(5)}  ${String(logs.length).padStart(6)} 条  ${Date.now() - t0}ms`);
    } catch (e) {
      console.log(`❌ ${name.padEnd(11)} range=${String(r).padStart(5)}  ${Date.now() - t0}ms  ${String(e).split('\n')[0]}`);
    }
  }
}
