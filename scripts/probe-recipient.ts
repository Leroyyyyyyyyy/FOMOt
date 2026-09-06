/**
 * 判定 /v2/users/:id/swaps 的 `recipient` 到底是「用户专属的链上账户」
 * 还是「中继的归集地址」。判据：不同用户的 recipient 集合是否相交。
 *
 * 做法仍是重写页面自己发出的请求，不读取任何凭据。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';

const HANDLES = process.argv.slice(2);
if (HANDLES.length < 2) { console.error('用法: probe-recipient.ts <handle> <handle> [...]（至少两个）'); process.exit(1); }
const OUT = new URL('../docs/evidence/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
const swaps = new Map<string, any[]>();
const users = new Map<string, any>();

ctx.on('response', async r => {
  if (!isFomoApi(r.url()) || !r.ok()) return;
  const u = new URL(r.url());
  try {
    if (/^\/v2\/users\/[^/]+\/swaps$/.test(u.pathname)) {
      const id = u.pathname.split('/')[3]!;
      const rows = (await r.json())?.responseObject?.swaps ?? [];
      if (Array.isArray(rows) && rows.length > (swaps.get(id)?.length ?? 0)) swaps.set(id, rows);
    } else if (/^\/v2\/users\/userHandle\//.test(u.pathname)) {
      const ro = (await r.json())?.responseObject;
      if (ro?.id) users.set(ro.id, ro);
    }
  } catch { /* ignore */ }
});

await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(9_000);
for (const h of HANDLES) {
  await page.goto(`${FOMO_ORIGIN}/profile/${h}`, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(11_000);
}

const sets = new Map<string, Set<string>>();
console.log('\n用户'.padEnd(28) + 'evmAddress'.padEnd(44) + 'swaps  不同 recipient');
for (const [id, rows] of swaps) {
  const u = users.get(id);
  const rec = new Set(rows.map((s: any) => String(s.recipient ?? '').toLowerCase()).filter(Boolean));
  sets.set(id, rec);
  console.log(`${String(u?.displayName ?? id).slice(0, 26).padEnd(28)}${String(u?.evmAddress ?? '?').padEnd(44)}${String(rows.length).padStart(5)}  ${rec.size}`);
  for (const r of rec) {
    const isOwn = r === String(u?.evmAddress ?? '').toLowerCase();
    console.log(`      ${r}${isOwn ? '   ← 等于该用户的 evmAddress' : ''}`);
  }
}

const ids = [...sets.keys()];
let overlap = false;
console.log('\n=== 两两交集 ===');
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const a = sets.get(ids[i]!)!, b = sets.get(ids[j]!)!;
  const inter = [...a].filter(x => b.has(x));
  if (inter.length) overlap = true;
  console.log(`  ${users.get(ids[i]!)?.displayName ?? ids[i]} ∩ ${users.get(ids[j]!)?.displayName ?? ids[j]} = ${inter.length ? inter.join(', ') : '空'}`);
}
console.log(`\n结论: ${overlap
  ? 'recipient 在不同用户间**重合** → 是中继归集地址，不能当身份证据。'
  : 'recipient 在不同用户间**互不相交** → 像是用户专属账户，可作为候选；仍需核对最终 Transfer、网络与代币才能升为 confirmed。'}`);

writeFileSync(`${OUT}recipient-probe.json`, JSON.stringify({
  at: Date.now(),
  users: [...swaps.keys()].map(id => ({
    id, displayName: users.get(id)?.displayName ?? null, evmAddress: users.get(id)?.evmAddress ?? null,
    swapCount: swaps.get(id)!.length, recipients: [...sets.get(id)!],
  })), overlap,
}, null, 2));
await ctx.close();
process.exit(0);
