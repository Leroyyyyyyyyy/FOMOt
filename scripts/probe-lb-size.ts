/** 榜单容量与 aggregatedSnapshot 的入参形态——判断能否按 userId 查任意用户的 24H 收益。 */
import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';
const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
const urls: string[] = [];
ctx.on('response', async r => {
  if (!isFomoApi(r.url())) return;
  const u = new URL(r.url());
  if (!/leaderboard|aggregatedSnapshot|hodlers\/top/.test(u.pathname)) return;
  urls.push(`${r.status()} ${u.pathname}${u.search}`);
  if (u.pathname === '/v2/leaderboard/24h') {
    try {
      const j: any = await r.json();
      const lb = j?.responseObject?.leaderboard;
      if (Array.isArray(lb)) {
        console.log(`\n/v2/leaderboard/24h -> ${lb.length} 行`);
        console.log('  行的键:', Object.keys(lb[0] ?? {}).join(', '));
        const pn = lb.map((x: any) => x.pnl24h).filter((n: any) => typeof n === 'number');
        console.log(`  pnl24h: min=${Math.min(...pn)} max=${Math.max(...pn)} 负数=${pn.filter((n: number) => n < 0).length} 零=${pn.filter((n: number) => n === 0).length}`);
        console.log('  responseObject 顶层键:', Object.keys(j.responseObject).join(', '));
      }
    } catch { /* ignore */ }
  }
});
await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(14_000);
console.log('\n带查询串的请求:');
for (const u of [...new Set(urls)]) console.log('  ' + u);
await ctx.close();
process.exit(0);
