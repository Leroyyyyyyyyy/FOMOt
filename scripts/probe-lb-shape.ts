import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';
import { parseLeaderboard } from '../src/fomo/api.js';

let got: any = null;
const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
ctx.on('response', async r => {
  try {
    if (!isFomoApi(r.url()) || new URL(r.url()).pathname !== '/v2/leaderboard/24h' || got) return;
    got = await r.json();
  } catch { /* ignore */ }
});
await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(25000);

if (!got) console.log('没捕获到');
else {
  console.log('顶层键:', Object.keys(got));
  const ro = got.responseObject;
  console.log('responseObject 类型:', Array.isArray(ro) ? `数组(${ro.length})` : typeof ro);
  if (ro && !Array.isArray(ro) && typeof ro === 'object') {
    console.log('responseObject 的键:', Object.keys(ro));
    for (const [k, v] of Object.entries(ro)) {
      console.log(`  ${k}: ${Array.isArray(v) ? `数组(${v.length})` : typeof v}`);
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        console.log(`     元素字段: ${Object.keys(v[0] as object).slice(0, 14).join(', ')}`);
      }
    }
  }
  console.log('\nparseLeaderboard 结果:', parseLeaderboard(got).length, '条');
}
await ctx.close();
process.exit(0);
