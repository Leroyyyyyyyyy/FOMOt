import { client, blockClock } from '../src/chain/client.js';
import { poolManagerAbi, erc20Abi } from '../src/chain/abi.js';
import { chain } from '../src/config.js';

const latest = await blockClock.sync();
// 约 30 分钟的池子，样本大一些
const logs = await client.getLogs({
  address: chain.poolManager, event: poolManagerAbi[0],
  fromBlock: latest - 18000n, toBlock: latest,
});
console.log(`样本: ${logs.length} 个新池\n`);

const cur = new Map<string, number>();
const hooks = new Map<string, number>();
for (const l of logs) {
  const a = l.args as any;
  for (const c of [a.currency0, a.currency1]) cur.set(c, (cur.get(c) ?? 0) + 1);
  hooks.set(a.hooks, (hooks.get(a.hooks) ?? 0) + 1);
}

console.log('=== 高频出现的 currency（= 计价资产候选）===');
for (const [addr, n] of [...cur].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  if (n < 3) continue;
  let sym = 'NATIVE ETH', dec: number | string = 18;
  const a = addr as `0x${string}`;
  if (addr !== '0x0000000000000000000000000000000000000000') {
    try {
      [sym, dec] = await Promise.all([
        client.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }).then(Number),
      ]) as [string, number];
    } catch { sym = '(读取失败)'; }
  }
  console.log(`  ${String(n).padStart(4)}x  ${addr}  ${sym} (${dec} dec)`);
}

console.log('\n=== hooks 分布（V4 hook = 发射平台指纹）===');
for (const [addr, n] of [...hooks].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(n).padStart(4)}x  ${addr}`);
}
