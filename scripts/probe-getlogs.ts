import { client, blockClock } from '../src/chain/client.js';
import { poolManagerAbi } from '../src/chain/abi.js';
import { chain } from '../src/config.js';

const latest = await blockClock.sync();
const from = latest - 1500n, to = latest;
const tries: [string, () => Promise<unknown[]>][] = [
  ['address only (viem)', () => client.getLogs({ address: chain.poolManager, fromBlock: from, toBlock: to })],
  ['single event  (viem)', () => client.getLogs({ address: chain.poolManager, event: poolManagerAbi[1], fromBlock: from, toBlock: to })],
  ['raw eth_getLogs no topics', async () => {
    const r = await client.request({
      method: 'eth_getLogs' as any,
      params: [{ address: chain.poolManager, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] as any,
    });
    return r as unknown[];
  }],
];
for (const [label, fn] of tries) {
  try { const r = await fn(); console.log(`✅ ${label.padEnd(26)} → ${r.length} 条`); }
  catch (e) { console.log(`❌ ${label.padEnd(26)} → ${String(e).split('\n')[0]}`); }
}
