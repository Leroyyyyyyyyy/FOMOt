/**
 * 决定性验证：/hodlers/top 对 networkId=56（BSC）给不给数据。
 *
 * 办法跟 platformPnl24h 一样——重写页面自己发出的那个请求的 tokens 参数，
 * 不读取任何凭据。只读，不入库。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';
import { parseHodlersTopResult } from '../src/fomo/api.js';
import { links } from '../src/config.js';

const TARGETS = [
  { net: 56,   name: 'BSC',       ca: '0xfe189e97832da1573e4e4ff034f4ffc3a15c7777' },  // MarsCoin，取自 cosby 持仓
  { net: 8453, name: 'Base',      ca: '0xb2000000000000000000004c27f6523082f41d01' },  // Basecat
  { net: 4663, name: 'Robinhood', ca: '0x39dbed3a2bd333467115de45665cc57f813c4571' },  // PONS，对照组
];
const OUT = new URL('../docs/evidence/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
let sub: { ca: string; net: number } | null = null;
const got = new Map<string, any>();

await page.route('**/hodlers/top*', async route => {
  const u = new URL(route.request().url());
  if (sub) u.searchParams.set('tokens', JSON.stringify([{ address: sub.ca, networkId: sub.net }]));
  await route.continue({ url: u.toString() });
});
page.on('response', async r => {
  try {
    if (!isFomoApi(r.url()) || new URL(r.url()).pathname !== '/hodlers/top') return;
    const raw = await r.json();
    const parsed = parseHodlersTopResult(raw);
    const key = `${sub?.net}|${sub?.ca}`;
    if (!got.has(key)) got.set(key, { status: r.status(), shapeOk: parsed.shapeOk, rows: parsed.rows });
  } catch { /* ignore */ }
});

for (const t of TARGETS) {
  sub = { ca: t.ca, net: t.net };
  await page.goto('about:blank').catch(() => {});
  await page.goto(links.fomo(t.ca), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(9_000);
}

console.log('\n=== /hodlers/top 逐链结果 ===');
for (const t of TARGETS) {
  const g = got.get(`${t.net}|${t.ca}`);
  if (!g) { console.log(`\n  ${t.name.padEnd(10)} networkId=${t.net}  ❌ 没拿到响应`); continue; }
  const row = g.rows?.[0];
  console.log(`\n  ${t.name.padEnd(10)} networkId=${t.net}  HTTP ${g.status}  结构${g.shapeOk ? '✅' : '❌'}`);
  if (row) {
    console.log(`     返回的 networkId : ${row.networkId}   ${row.networkId === t.net ? '✅ 与请求一致' : '⚠️ 与请求不符'}`);
    console.log(`     totalHolders     : ${row.fomoHolders ?? 'null'}`);
    console.log(`     topHolders 行数   : ${row.top.length}`);
    if (row.top[0]) console.log(`     首行             : ${row.top[0].user.handle ?? '?'}  amount=${row.top[0].amount}  pnl=${row.top[0].pnl}`);
  } else {
    console.log(`     responseObject 里没有该代币的条目 → 这条链多半不支持`);
  }
}
writeFileSync(`${OUT}bsc-hodlers-probe.json`, JSON.stringify({ at: Date.now(), targets: TARGETS, got: [...got] }, null, 2));
console.log(`\n已写入 docs/evidence/bsc-hodlers-probe.json`);
await ctx.close();
process.exit(0);
