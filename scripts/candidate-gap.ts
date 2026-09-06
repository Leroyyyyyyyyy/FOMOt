/** 候选离生产阈值还差多少——用来判断验收样本量够不够，不够就得说清楚原因。 */
import { activeTokens, volumeUsd } from '../src/chain/volume.js';
import { snapshotMarketCached } from '../src/chain/marketdata.js';
import { rules } from '../src/config.js';
import { chainRejection } from '../src/engine/rules.js';

const f = rules.filters;
const cands = activeTokens(5 * 60_000, 300);
let pass = 0; const reasons = new Map<string, number>();
const near: any[] = [];
for (const c of cands) {
  const m = snapshotMarketCached(c.ca);
  if (!m) { reasons.set('无市值快照', (reasons.get('无市值快照') ?? 0) + 1); continue; }
  const r = chainRejection(m, f);
  if (!r) { pass++; near.push({ ca: c.ca, sym: m.symbol, mc: m.marketCapUsd, v5: m.volume5m, v1: m.volume1h }); continue; }
  reasons.set(r, (reasons.get(r) ?? 0) + 1);
  if (m.volume5m > f.volume_5m_usd.min! * 0.4) near.push({ ca: c.ca, sym: m.symbol, mc: m.marketCapUsd, v5: m.volume5m, v1: m.volume1h, r });
}
console.log(`候选 ${cands.length}，通过链上门 ${pass}`);
console.log('拒绝原因:', Object.fromEntries(reasons));
console.log(`\n阈值: MC ${f.market_cap_usd.min}-${f.market_cap_usd.max} · 5m≥${f.volume_5m_usd.min} · 1h≥${f.volume_1h_usd.min} · 持币≥${f.holders_total.min}`);
console.log('\n最接近的候选:');
for (const n of near.sort((a, b) => b.v5 - a.v5).slice(0, 12)) {
  console.log(`  ${(n.sym ?? '?').padEnd(10)} MC $${Math.round(n.mc).toLocaleString().padStart(12)} · 5m $${Math.round(n.v5).toLocaleString().padStart(10)} · 1h $${Math.round(n.v1).toLocaleString().padStart(11)}  ${n.r ?? '✅ 通过'}`);
}
