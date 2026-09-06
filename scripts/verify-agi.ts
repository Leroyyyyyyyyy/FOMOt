import type { Address } from 'viem';
import { blockClock } from '../src/chain/client.js';
import { blockscout } from '../src/chain/blockscout.js';
import { deployment } from '../src/chain/deployment.js';
import { snapshotHolders } from '../src/chain/holders.js';

// 这个币刚才把固定分块打爆了，专门回归一下
const ca = '0xe7534eFB738182D5fF5C3d2aBBE6410047609065' as Address;
const latest = await blockClock.sync();
const c = await deployment(ca);
if (!c) throw new Error('拿不到部署区块');
const t0 = Date.now();
const snap = await snapshotHolders(ca, c.block, latest);
const bs = await blockscout.holdersCount(ca);
console.log(`跨度 ${latest - c.block} 块`);
console.log(`持币人 自建=${snap.total}  Blockscout=${bs}  偏差 ${bs ? ((snap.total - bs) / bs * 100).toFixed(1) : '?'}%  耗时 ${Date.now() - t0}ms`);
console.log(`Top3: ${snap.top.slice(0, 3).map(h => h.address.slice(0, 12)).join('  ')}`);
// 增量复核应该很快
const t1 = Date.now();
const again = await snapshotHolders(ca, c.block, await blockClock.sync());
console.log(`增量复核: ${again.total} 人  耗时 ${Date.now() - t1}ms  ← +0.8s 快照走的就是这条路径`);
