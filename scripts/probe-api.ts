import { openContext, FOMO_ORIGIN, FOMO_HEADERS } from '../src/fomo/session.js';

const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(6000);

// 只取 token 用于请求，不打印内容
const tok = await page.evaluate(() => {
  const out: Record<string, string> = {};
  for (const k of Object.keys(localStorage)) {
    if (/^privy:(token|id_token|pat|refresh_token)$/.test(k)) out[k] = localStorage.getItem(k) ?? '';
  }
  return out;
}).catch(() => ({} as Record<string, string>));

console.log('拿到的凭据键:');
for (const [k, v] of Object.entries(tok)) console.log(`  ${k.padEnd(22)} 长度 ${v.length}`);

const bearer = (tok['privy:token'] ?? '').replace(/^"|"$/g, '');
const endpoints = ['/v2/leaderboard/24h', '/hodlers/top?tokenAddress=0x385f4f8ae47651ce5f58f5265395a669f8281e18&networkId=4663'];

console.log('\n=== 用浏览器上下文的 request API 直调（不受 CORS 限制）===');
for (const ep of endpoints) {
  const short = ep.split('?')[0] ?? ep;
  for (const [label, headers] of [
    ['无鉴权头', {}],
    ['带 Bearer', bearer ? { authorization: `Bearer ${bearer}` } : null],
  ] as const) {
    if (!headers) continue;
    try {
      const r = await ctx.request.get(`https://prod-api.fomo.family${ep}`, {
        headers: { ...FOMO_HEADERS, ...headers, referer: `${FOMO_ORIGIN}/` },
        timeout: 15000,
      });
      const raw = await r.text();
      const body = raw.length > 200 ? `${raw.length} 字节: ${raw.slice(0, 150).replace(/\s+/g, ' ')}…` : raw.replace(/\s+/g, ' ');
      console.log(`  ${r.status()}  ${short.padEnd(24)} ${label.padEnd(10)} → ${body}`);
    } catch (e) {
      console.log(`  ERR  ${short.padEnd(24)} ${label.padEnd(10)} → ${(String(e).split('\n')[0] ?? '').slice(0, 110)}`);
    }
  }
}
await ctx.close();
process.exit(0);
