/** 找任意用户的「当前全时段总收益」来源：aggregatedSnapshot(复数) 的入参与返回，
 *  以及 aggregatedSnapshotById 能否取到今天的边界。仍然只重写页面自己的请求。 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';

const HANDLE = process.argv[2] ?? 'cosby';
const OUT = new URL('../docs/evidence/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
const seen: any[] = [];
let overrideSid: number | null = null;

await page.route('**/v2/userTokens/aggregatedSnapshotById*', async route => {
  const u = new URL(route.request().url());
  if (overrideSid) u.searchParams.set('snapshotId', String(overrideSid));
  await route.continue({ url: u.toString() });
});
ctx.on('response', async r => {
  if (!isFomoApi(r.url())) return;
  const u = new URL(r.url());
  if (!/aggregatedSnapshot/.test(u.pathname)) return;
  try {
    const j = await r.json();
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), status: r.status(), ro: j?.responseObject ?? null });
  } catch { /* ignore */ }
});

await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(9_000);
await page.goto(`${FOMO_ORIGIN}/profile/${HANDLE}`, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
await page.waitForTimeout(13_000);

for (const s of seen) {
  console.log(`\n${'='.repeat(70)}\n${s.path}  status=${s.status}`);
  console.log('  query:', JSON.stringify(s.query));
  if (Array.isArray(s.ro)) {
    console.log(`  数组 ${s.ro.length} 项；首项 ${JSON.stringify(s.ro[0])}；末项 ${JSON.stringify(s.ro[s.ro.length - 1])}`);
    const withT = s.ro.slice(-4).map((x: any) => ({ ...x, iso: x.snapshotId ? new Date(x.snapshotId * 1000).toISOString() : undefined }));
    console.log('  最后 4 项:', JSON.stringify(withT));
  } else console.log('  ', JSON.stringify(s.ro));
}

// 试今天的边界，看能不能拿到「当前」总收益
const base = seen.find(s => s.path.endsWith('ById'))?.query?.snapshotId;
if (base) {
  for (const delta of [86400, 0, -86400]) {
    overrideSid = Number(base) + delta;
    const before = seen.length;
    await page.goto('about:blank').catch(() => {});
    await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await page.waitForTimeout(6_500);
    const got = seen.slice(before).filter(s => s.path.endsWith('ById'));
    console.log(`\nsnapshotId=${overrideSid} (${new Date(overrideSid * 1000).toISOString()}) ->`,
      got.map(g => JSON.stringify(g.ro)).join(' | ') || '(无)');
  }
}
writeFileSync(`${OUT}agg-series.json`, JSON.stringify(seen, null, 2));
await ctx.close();
process.exit(0);
