import { rules } from '../src/config.js';
import { activeTokens } from '../src/chain/volume.js';
import { snapshotMarket } from '../src/chain/marketdata.js';
import { deployment } from '../src/chain/deployment.js';
import { isWarm } from '../src/chain/holders.js';
import { fmtUsd } from '../src/chain/pricing.js';

const f = rules.filters, u = rules.universe;
const ok = (b: boolean) => (b ? '✅' : '❌');
const inR = (v: number, r: { min?: number; max?: number }) =>
  (r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max);

console.log(`规则: MC ${fmtUsd(f.market_cap_usd.min ?? 0)}–${fmtUsd(f.market_cap_usd.max ?? 0)} · 5m≥${fmtUsd(f.volume_5m_usd.min ?? 0)} · 1h≥${fmtUsd(f.volume_1h_usd.min ?? 0)} · 币龄 ${u.min_age_seconds}s–${u.max_age_minutes}min\n`);

for (const c of activeTokens(5 * 60_000, 25)) {
  const m = await snapshotMarket(c.ca);
  if (!m) { console.log(`${c.ca.slice(0, 10)}… ❌ 没有行情（缺池价或元数据）`); continue; }
  const dep = await deployment(c.ca);
  const ageMin = dep ? (Date.now() - dep.ts) / 60000 : null;

  const gates = [
    ['市值', inR(m.marketCapUsd, f.market_cap_usd), fmtUsd(m.marketCapUsd)],
    ['5m量', inR(m.volume5m, f.volume_5m_usd), fmtUsd(m.volume5m)],
    ['1h量', inR(m.volume1h, f.volume_1h_usd), fmtUsd(m.volume1h)],
    ['币龄', ageMin !== null && ageMin <= u.max_age_minutes && ageMin * 60 >= u.min_age_seconds,
      ageMin === null ? '查不到' : `${ageMin.toFixed(1)}min`],
    ['已预热', isWarm(c.ca), isWarm(c.ca) ? 'yes' : 'no'],
  ] as const;

  const pass = gates.every(g => g[1]);
  console.log(`${(m.symbol ?? '?').padEnd(13)} ${pass ? '🔔 会触发' : '  '}  ` +
    gates.map(g => `${g[0]} ${ok(g[1])}${g[2]}`).join(' · '));
}
