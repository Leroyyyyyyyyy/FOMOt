/** 把某个用户的 /v2/users/:id/balances 与 aggregatedSnapshot 完整结构摊开，并抓页面可见文本，
 *  用来判断「全平台 24H 收益」到底存不存在。不打印凭据。 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';

const HANDLE = process.argv[2] ?? 'cosby';
const OUT = new URL('../docs/evidence/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const bodies = new Map<string, any>();
const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
ctx.on('response', async r => {
  if (!isFomoApi(r.url())) return;
  let p: string; try { p = new URL(r.url()).pathname; } catch { return; }
  if (!/\/balances|aggregatedSnapshot|userHandle|spotlight|\/swaps/.test(p)) return;
  try { const j = await r.json(); if (!bodies.has(p) || p.includes('balances')) bodies.set(p, j); } catch { /* ignore */ }
});
await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(8_000);
await page.goto(`${FOMO_ORIGIN}/profile/${HANDLE}`, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
await page.waitForTimeout(14_000);

for (const [p, j] of bodies) {
  const ro = j?.responseObject;
  console.log(`\n${'='.repeat(72)}\n${p}`);
  if (ro === undefined) { console.log('  无 responseObject'); continue; }
  if (Array.isArray(ro)) {
    console.log(`  responseObject: 数组 ${ro.length} 项；首项键: ${Object.keys(ro[0] ?? {}).join(', ')}`);
    console.log('  首项:', JSON.stringify(ro[0]).slice(0, 700));
  } else {
    console.log('  顶层键:', Object.keys(ro).join(', '));
    for (const [k, v] of Object.entries(ro)) {
      if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) console.log(`    ${k.padEnd(28)} ${JSON.stringify(v)}`);
      else if (Array.isArray(v)) console.log(`    ${k.padEnd(28)} 数组[${v.length}] 首项键: ${Object.keys(v[0] ?? {}).join(', ')}`);
      else console.log(`    ${k.padEnd(28)} 对象 键: ${Object.keys(v as object).join(', ')}`);
    }
    if (Array.isArray(ro.balances) && ro.balances[0]) {
      console.log('\n  balances[0] 展开:');
      console.log('   ', JSON.stringify(ro.balances[0]).slice(0, 1400));
    }
  }
}
const txt = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
console.log(`\n${'='.repeat(72)}\n页面可见文本（前 2500 字）:\n${txt}`);
writeFileSync(`${OUT}user-balances-${HANDLE}.json`, JSON.stringify([...bodies], null, 2));
await ctx.close();
process.exit(0);
