import { client, blockClock } from '../src/chain/client.js';
const latest = await blockClock.sync();
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;   // 早就存在的代币
for (const back of [0n, 1000n, 100_000n, 1_000_000n, 10_000_000n]) {
  const b = latest - back;
  try {
    const code = await client.getCode({ address: USDG, blockNumber: b });
    const desc = code && code !== '0x' ? `${code.length} 字节` : '空';
    console.log(`区块 ${b} (往回 ${back})  → code ${desc}`);
  } catch (e) {
    console.log(`区块 ${b} (往回 ${back})  → ❌ ${(String(e).split('\n')[0] ?? '').slice(0, 90)}`);
  }
}
