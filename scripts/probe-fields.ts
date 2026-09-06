import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';
import { harvest } from '../src/fomo/extract.js';

const WANT = ['/v2/leaderboard/24h', '/hodlers/top', '/proxy/trendingTokens'];
const grabbed = new Map<string, unknown>();

const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
ctx.on('response', async r => {
  const p = (() => { try { return new URL(r.url()).pathname; } catch { return ''; } })();
  if (!isFomoApi(r.url()) || !WANT.includes(p) || grabbed.has(p)) return;
  try { grabbed.set(p, await r.json()); } catch { /* ignore */ }
});

await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(16000);

for (const p of WANT) {
  const json = grabbed.get(p);
  console.log(`\n${'='.repeat(70)}\n${p}`);
  if (!json) { console.log('  (本次没捕获到)'); continue; }

  // 找出承载数组的那一层，打印它第一个元素的字段名
  const findArr = (o: unknown, d = 0): unknown[] | null => {
    if (d > 6 || !o || typeof o !== 'object') return null;
    if (Array.isArray(o) && o.length && typeof o[0] === 'object') return o;
    for (const v of Object.values(o as Record<string, unknown>)) {
      const r = findArr(v, d + 1); if (r) return r;
    }
    return null;
  };
  const arr = findArr(json);
  console.log(`  顶层键: ${Array.isArray(json) ? '(数组)' : Object.keys(json as object).slice(0, 12).join(', ')}`);
  if (arr?.[0]) console.log(`  元素字段: ${Object.keys(arr[0] as object).join(', ')}`);

  const recs = harvest(json);
  console.log(`  提取到 ${recs.length} 条，前 3 条:`);
  for (const r of recs.slice(0, 3)) {
    console.log(`    handle=${r.handle ?? '-'}  rank=${r.rank ?? '-'}  fans=${r.followers ?? '-'}  pnl=${r.pnl24h ?? '-'}  bal=${r.balance ?? '-'}  addr=${r.address ?? '-'}`);
  }
}
await ctx.close();
process.exit(0);
