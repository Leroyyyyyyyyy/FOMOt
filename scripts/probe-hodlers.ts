import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';

let got: any = null;
const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
ctx.on('response', async r => {
  try {
    if (!isFomoApi(r.url()) || new URL(r.url()).pathname !== '/hodlers/top' || got) return;
    got = await r.json();
  } catch { /* ignore */ }
});
await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(16000);

if (!got) { console.log('没捕获到 /hodlers/top'); } else {
  // responseObject 是数组（每个代币一项），不是对象
  const list = Array.isArray(got.responseObject) ? got.responseObject : [got.responseObject ?? got];
  console.log(`responseObject: 数组，${list.length} 项`);
  const ro = list[0] ?? {};
  console.log('tokenAddress :', ro.tokenAddress);
  console.log('networkId    :', ro.networkId);
  console.log('totalHolders :', ro.totalHolders);
  console.log('topHolders   :', Array.isArray(ro.topHolders) ? ro.topHolders.length + ' 个' : typeof ro.topHolders);
  const h = ro.topHolders?.[0];
  if (h) {
    console.log('\n单个持有人的完整结构:');
    for (const [k, v] of Object.entries(h)) {
      const s = v && typeof v === 'object' ? `{${Object.keys(v).slice(0, 8).join(',')}}` : JSON.stringify(v);
      console.log(`  ${k.padEnd(22)} ${String(s).slice(0, 110)}`);
    }
    console.log('\nuser 完整标量字段:');
    for (const [k, v] of Object.entries(h.user ?? {})) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v))
        console.log(`  ${k.padEnd(22)} ${String(v).slice(0, 130)}`);
    }
  }
}
await ctx.close();
process.exit(0);
