import { client } from '../src/chain/client.js';
// AGI(0x07A4be…) 的部署交易，区块 54349310，属于「历史」范围
const hash = '0xc2235db2030db162d157676dc32fd28e209fadb2a4f79149a4f909ec90c066fa' as const;
try {
  const tx = await client.getTransaction({ hash });
  console.log(`✅ eth_getTransactionByHash → 区块 ${tx.blockNumber}`);
  const b = await client.getBlock({ blockNumber: tx.blockNumber! });
  console.log(`✅ eth_getBlockByNumber     → 时间戳 ${b.timestamp} (${new Date(Number(b.timestamp) * 1000).toISOString()})`);
} catch (e) {
  console.log(`❌ ${String(e).split('\n')[0]}`);
}
