import { createFomoProvider } from '../src/fomo/scraper.js';
import { fmtUsd, fmtAmount } from '../src/chain/pricing.js';

const p = await createFomoProvider();
console.log(`ready = ${p.ready}\n`);
if (!p.ready) { console.log('未登录，先 npm run login'); process.exit(1); }

await new Promise(r => setTimeout(r, 9000));      // 等首页的榜单接口回来
const board = await p.leaderboard24h();
console.log(`=== 24H 盈利榜: ${board.length} 人 ===`);
for (const b of board.slice(0, 6)) {
  console.log(`  #${String(b.rank).padStart(3)} ${(b.handle ?? '?').padEnd(18)} 粉丝 ${fmtAmount(b.followers ?? 0).padStart(9)}  24h ${fmtUsd(b.pnl24h)}`);
}

const ca = '0x385f4f8ae47651ce5f58f5265395a669f8281e18';   // 原截图里那个 MEME
console.log(`\n=== ${ca} 的 FOMO 持币情况 ===`);
const s = await p.tokenStats(ca);
if (!s) { console.log('  拿不到'); } else {
  console.log(`  Fomo 持币人: ${s.fomoHolders}   Top: ${s.top.length} 个   数据新鲜度 ${s.freshMs}ms`);
  for (const h of s.top.slice(0, 6)) {
    console.log(`   #${String(h.rank).padStart(2)} ${(h.handle ?? '?').padEnd(18)} ${fmtAmount(h.amount ?? 0).padStart(9)} 枚 · 粉丝 ${fmtAmount(h.followers ?? 0).padStart(8)} · 本币盈亏 ${fmtUsd(h.pnl ?? 0)}${h.isDev ? ' [DEV]' : ''}`);
  }
  const byUser = new Map(board.map(b => [b.userId ?? b.handle ?? '', b]));
  const hit = s.top.slice(0, 10).filter(h => byUser.has(h.userId ?? h.handle ?? ''));
  console.log(`\n  Top10 里上了 24H 盈利榜的: ${hit.length}/10`);
  for (const h of hit) {
    const b = byUser.get(h.userId ?? h.handle ?? '')!;
    console.log(`    #${b.rank} ${h.handle} · ${fmtAmount(h.amount ?? 0)} 枚 · 粉丝 ${fmtAmount(h.followers ?? 0)} · 全平台24h ${fmtUsd(b.pnl24h)}`);
  }
}
process.exit(0);
