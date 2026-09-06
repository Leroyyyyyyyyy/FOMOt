/**
 * Phase 2 第 4 步：找「普通用户的全平台 24H 收益」来源。
 * 必须覆盖未上盈利榜的用户和负收益用户，不能只看盈利榜。
 * 只打印字段与数值，不打印任何 header / cookie / 凭据。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';

const USERS = process.argv.slice(2);
if (!USERS.length) { console.error('用法: probe-user-pnl.ts <userId> [userId...]'); process.exit(1); }
const OUT = new URL('../docs/evidence/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
const seen: { user: string; path: string; status: number; bytes: number }[] = [];
const bodies = new Map<string, unknown>();
let current = '';

ctx.on('response', async r => {
  if (!isFomoApi(r.url())) return;
  let u: URL; try { u = new URL(r.url()); } catch { return; }
  const path = u.pathname;
  let bytes = 0; let json: unknown;
  try { const t = await r.text(); bytes = t.length; json = JSON.parse(t); } catch { /* ignore */ }
  seen.push({ user: current, path, status: r.status(), bytes });
  const key = `${current}|${path}`;
  if (json !== undefined && !bodies.has(key)) bodies.set(key, json);
});

function scalars(o: unknown, pre = '', out = new Map<string, unknown>(), d = 0): Map<string, unknown> {
  if (d > 8 || o === null || typeof o !== 'object') return out;
  if (Array.isArray(o)) { if (o.length) scalars(o[0], `${pre}[]`, out, d + 1); return out; }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const key = pre ? `${pre}.${k}` : k;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out.set(key, v);
    else scalars(v, key, out, d + 1);
  }
  return out;
}

await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(9_000);

for (const id of USERS) {
  current = id;
  console.log(`\n${'='.repeat(74)}\n用户 ${id}`);
  for (const url of [`${FOMO_ORIGIN}/profile/${id}`, `${FOMO_ORIGIN}/${id}`, `${FOMO_ORIGIN}/user/${id}`]) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await page.waitForTimeout(7_000);
    if (page.url().includes(id)) break;          // 没被弹走就说明这条路由是对的
  }
  console.log('  最终地址:', page.url());
  const mine = seen.filter(s => s.user === id);
  console.log('  该用户页触发的端点:');
  for (const s of [...new Map(mine.map(s => [s.path, s])).values()]) {
    console.log(`    ${String(s.status).padEnd(4)} ${s.path}`);
  }
  for (const [key, body] of bodies) {
    if (!key.startsWith(`${id}|`)) continue;
    const path = key.slice(id.length + 1);
    const money = [...scalars(body)].filter(([k]) => /pnl|24h|profit|roi|gain|realiz|cost/i.test(k));
    if (money.length) {
      console.log(`  --- ${path}`);
      for (const [k, v] of money.slice(0, 30)) console.log(`      ${k.padEnd(50)} ${JSON.stringify(v)}`);
    }
  }
}

writeFileSync(`${OUT}user-pnl-endpoints.json`, JSON.stringify(
  { at: Date.now(), users: USERS, seen: [...new Map(seen.map(s => [`${s.user}|${s.path}`, s])).values()] }, null, 2));
console.log('\n已保存 -> docs/evidence/user-pnl-endpoints.json');
await ctx.close();
process.exit(0);
