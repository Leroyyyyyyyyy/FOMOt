/** 拿原版截图里的两条样本回测当前规则——它们都是原版推过的，理应全部通过。 */
import { rules } from '../src/config.js';
import { chainRejection, initialRejection, recheckRejection, inRange } from '../src/engine/rules.js';
import type { Enriched } from '../src/engine/enrich.js';

const f = rules.filters;

const samples = [
  { name: 'MEME', mc: 126_120, v5m: 22_360, v1h: 212_120, holders: 178, fomo: 72, board: 2 },
  { name: 'HDR ', mc: 91_470, v5m: 71_040, v1h: 71_040, holders: 167, fomo: 13, board: 0 },
];

for (const s of samples) {
  const ratio = s.fomo / s.holders;
  const enriched: Enriched = {
    available: true, fomoHolders: s.fomo,
    leaders: Array.from({ length: s.board }, (_, i) => ({ rank: i + 1, handle: 'sample', balance: 1, followers: 1, pnl24h: 1 , identityConfirmed: true})),
    leaderboardAvailable: true,
    top10TokenPnl: 0, top10TokenPnlCovered: 10, top10TokenProfitable: 0,
    top10PlatformPnl24h: null, top10PlatformCovered: 0, top10PlatformWindow: null,
    identified: 10, top10Count: 10, identityCoverage: 10,
    fomoTakenTs: Date.now(), boardTakenTs: Date.now(), aggregatedTs: Date.now(), ingestMs: 1,
  };
  const market = { marketCapUsd: s.mc, volume5m: s.v5m, volume1h: s.v1h };
  const rejects = [chainRejection(market, f), initialRejection(s.holders, enriched, f), recheckRejection(s.holders, enriched, f)].filter(Boolean);
  const gates: [string, boolean, string][] = [
    ['市值', inRange(s.mc, f.market_cap_usd), `$${(s.mc / 1000).toFixed(2)}K`],
    ['5m量', inRange(s.v5m, f.volume_5m_usd), `$${(s.v5m / 1000).toFixed(2)}K`],
    ['1h量', inRange(s.v1h, f.volume_1h_usd), `$${(s.v1h / 1000).toFixed(2)}K`],
    ['全链持币', inRange(s.holders, f.holders_total), String(s.holders)],
    ['Fomo人数', inRange(s.fomo, f.fomo_holders), String(s.fomo)],
    ['Fomo占比', inRange(ratio, f.fomo_holder_ratio), `${(ratio * 100).toFixed(1)}%`],
    ['榜单持有', inRange(s.board, f.fomo_leaderboard_holders), `${s.board}人`],
  ];
  const pass = rejects.length === 0;
  console.log(`${s.name}  ${pass ? '🔔 会推送' : '❌ 会被拒'}`);
  for (const [n, ok, v] of gates) console.log(`     ${ok ? '✅' : '❌'} ${n.padEnd(9)} ${v}`);
  console.log();
}
