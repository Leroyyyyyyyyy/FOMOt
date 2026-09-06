import { client, blockClock } from '../src/chain/client.js';
import { erc20Abi } from '../src/chain/abi.js';

const FACTORY = '0x4A3e797B2E4DD1cf96B352513Ea91B2f6449e74a';
const latest = await blockClock.sync();

const logs = await client.getLogs({ address: FACTORY, fromBlock: latest - 6000n, toBlock: latest });
console.log(`工厂 ${FACTORY} 最近 10 分钟: ${logs.length} 条日志\n`);

const byTopic = new Map<string, typeof logs>();
for (const l of logs) {
  const t = l.topics[0]!;
  if (!byTopic.has(t)) byTopic.set(t, []);
  byTopic.get(t)!.push(l);
}
for (const [t, ls] of [...byTopic].sort((a, b) => b[1].length - a[1].length)) {
  const ex = ls[0]!;
  console.log(`${String(ls.length).padStart(4)}x  ${t}  topics=${ex.topics.length} data=${(ex.data.length - 2) / 64}w`);
}

// 看看最新那条日志里的地址是不是新代币
const newest = logs.at(-1);
if (newest) {
  console.log('\n最新一条原始日志:');
  console.log('  topics:', newest.topics);
  console.log('  data  :', newest.data.slice(0, 400));
  // 从 topics/data 里抠出所有像地址的 32 字节字
  const words = [...newest.topics.slice(1), ...(newest.data.slice(2).match(/.{64}/g) ?? [])];
  for (const w of words) {
    if (!/^0{24}[0-9a-f]{40}$/i.test(w)) continue;
    const addr = ('0x' + w.slice(24)) as `0x${string}`;
    try {
      const [s, n] = await Promise.all([
        client.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: addr, abi: erc20Abi, functionName: 'name' }),
      ]);
      console.log(`  → ${addr} 是 ERC20: ${s} (${n})   区块 ${newest.blockNumber}`);
    } catch { console.log(`  → ${addr} 非 ERC20`); }
  }
}
