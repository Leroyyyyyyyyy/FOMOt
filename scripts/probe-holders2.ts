import type { Address } from 'viem';
import { blockClock } from '../src/chain/client.js';
import { blockscout } from '../src/chain/blockscout.js';
import { snapshotHolders } from '../src/chain/holders.js';
import { chain } from '../src/config.js';

const latest = await blockClock.sync();
const cases: Address[] = [
  '0x07A4be3104C1a784433B101dA0aE59Af70a7A255', // AGI  — Blockscout 说 622
  '0xE7bf56e415b1DeE6bBcE1dBd6f58Efc332da04AF', // Inkky — Blockscout 说 82
  '0x192Baf67e094D1e0af5862A3Ff6DA0A3FaA7d501', // COMS — Blockscout 说 518
];
for (const ca of cases) {
  const c = await blockscout.creation(ca);
  if (!c) { console.log(ca, '拿不到部署区块'); continue; }
  const ageMin = (Date.now() - c.ts) / 60000;
  const t0 = Date.now();
  const snap = await snapshotHolders(ca, c.block, latest);
  const bs = await blockscout.holdersCount(ca);
  const diff = bs ? ((snap.total - bs) / bs * 100).toFixed(1) : '?';
  console.log(
    `${ca}\n  部署区块 ${c.block}  币龄 ${ageMin.toFixed(1)}min  跨度 ${latest - c.block} 块\n` +
    `  持币人 自建=${snap.total}  Blockscout=${bs}  偏差 ${diff}%   耗时 ${Date.now() - t0}ms`,
  );
}
