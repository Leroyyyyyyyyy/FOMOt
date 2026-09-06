import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';

const headless = process.env.HEADLESS !== 'false';
const ctx = await openContext(headless);
const page = ctx.pages()[0] ?? (await ctx.newPage());

const hosts = new Map<string, number>();
const apiUrls: string[] = [];
const errors: string[] = [];
ctx.on('request', r => {
  const h = new URL(r.url()).host;
  hosts.set(h, (hosts.get(h) ?? 0) + 1);
});
ctx.on('response', async r => {
  if (!isFomoApi(r.url())) return;
  let recs = -1;
  try {
    if ((r.headers()['content-type'] ?? '').includes('json')) {
      const { harvest } = await import('../src/fomo/extract.js');
      recs = harvest(await r.json()).length;
    }
  } catch { /* 读不到 body */ }
  apiUrls.push(`${r.status()} ${new URL(r.url()).host}${new URL(r.url()).pathname}  → ${recs < 0 ? '非JSON' : recs + ' 条'}`);
});
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
page.on('pageerror', e => errors.push(`pageerror: ${String(e).slice(0, 160)}`));

const nav: string[] = [];
page.on('framenavigated', f => { if (f === page.mainFrame()) nav.push(f.url()); });

console.log(`headless=${headless}  打开 ${FOMO_ORIGIN} …`);
await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(e => console.log('goto:', String(e).slice(0, 100)));
await page.waitForTimeout(14000);

console.log('\n=== 导航轨迹 ===');    nav.forEach(u => console.log('  ' + u));
console.log('=== 最终地址 ===\n  ' + page.url());
console.log('\n=== 请求过的 host ===');
for (const [h, n] of [...hosts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}x ${h}`);
console.log('\n=== prod-api 响应 ===');
console.log(apiUrls.length ? apiUrls.map(u => '  ' + u).join('\n') : '  (无)');
console.log('\n=== 控制台错误 ===');
console.log(errors.length ? errors.slice(0, 8).map(e => '  ' + e).join('\n') : '  (无)');
console.log('\n=== 页面可见文字（前 400 字）===');
console.log('  ' + (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 400));
await page.screenshot({ path: 'data/diagnose.png', fullPage: false }).catch(() => {});
console.log('\n截图: data/diagnose.png');
await ctx.close();
process.exit(0);
