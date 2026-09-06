import { openContext, isFomoApi } from '../src/fomo/session.js';
import { links } from '../src/config.js';

const ca = process.argv[2] ?? '0x2f219c706e052dc25372a0c59dcc2afe0cab12f3';
const needles = process.argv.slice(3).map(x => x.toLowerCase());
const ctx = await openContext(true);
const page = ctx.pages()[0] ?? await ctx.newPage();
const endpoints = new Set<string>();
const bodies = new Map<string, unknown>();
ctx.on('response', async res => {
  if (!isFomoApi(res.url()) || !(res.headers()['content-type'] ?? '').includes('json')) return;
  const path = new URL(res.url()).pathname;
  endpoints.add(path);
  try {
    const raw = await res.text();
    try { bodies.set(path, JSON.parse(raw)); } catch { /* ignore */ }
    for (const needle of needles) {
      const at = raw.toLowerCase().indexOf(needle);
      if (at >= 0) console.log(path, needle, raw.slice(Math.max(0, at - 180), at + needle.length + 180));
    }
  } catch { /* diagnostic only */ }
});
await page.goto(links.fomo(ca), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
await page.waitForTimeout(20_000);
if (process.env.PROBE_PROFILE) {
  await page.goto(`https://fomo.family/profile/${process.env.PROBE_PROFILE}`,
    { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(12_000);
}
console.log('endpoints', [...endpoints].sort());
console.log('user links', await page.locator('a').evaluateAll(as => as.map(a => (a as HTMLAnchorElement).href)
  .filter(h => /user|profile/i.test(h)).slice(0, 20)).catch(() => []));
const holderJson = JSON.stringify(bodies.get('/hodlers/top') ?? {});
const tradeJson = JSON.stringify(bodies.get('/trades') ?? {});
const tradeId = /"tradeId":"([^"]+)"/.exec(holderJson)?.[1];
if (tradeId) {
  const at = tradeJson.indexOf(tradeId);
  console.log('holder tradeId in /trades', tradeId, at >= 0,
    at >= 0 ? tradeJson.slice(Math.max(0, at - 300), at + 500) : '');
}
for (const [path, body] of bodies) {
  if (/balances|swaps/.test(path)) console.log(path, JSON.stringify(body).slice(0, 1800));
}
await ctx.close();
