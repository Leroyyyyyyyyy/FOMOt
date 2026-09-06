/**
 * Phase 2 数据调查：/hodlers/top 的 pnl 家族字段到底是什么口径，
 * 以及「全平台 24H 收益」在哪个接口。
 *
 * 只打印字段名和数值，绝不打印 header / cookie / localStorage —— 凭据不进日志也不进样本。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';
import { links } from '../src/config.js';

const CA = process.argv[2] ?? '0x39dbed3a2bd333467115de45665cc57f813c4571';
const OUT = new URL('../docs/evidence/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const bodies = new Map<string, unknown>();
const hits = new Map<string, number>();
const failures: { path: string; status: number }[] = [];

const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
ctx.on('response', async r => {
  if (!isFomoApi(r.url())) return;
  let path: string; try { path = new URL(r.url()).pathname; } catch { return; }
  hits.set(path, (hits.get(path) ?? 0) + 1);
  if (!r.ok()) { failures.push({ path, status: r.status() }); return; }
  if (!(r.headers()['content-type'] ?? '').includes('json')) return;
  try { if (!bodies.has(path)) bodies.set(path, await r.json()); } catch { /* ignore */ }
});

await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(12_000);
await page.goto(links.fomo(CA), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
await page.waitForTimeout(18_000);

console.log('=== 命中的端点 ===');
for (const [p, n] of [...hits].sort()) console.log(`  ${String(n).padStart(3)}x  ${p}`);
if (failures.length) { console.log('=== 失败响应 ==='); for (const f of failures) console.log(`  ${f.status}  ${f.path}`); }

/** 递归收集所有出现过的字段路径，只留标量，用来找收益类字段。 */
function paths(o: unknown, pre = '', out = new Map<string, unknown>(), d = 0): Map<string, unknown> {
  if (d > 8 || o === null || typeof o !== 'object') return out;
  if (Array.isArray(o)) { if (o.length) paths(o[0], `${pre}[]`, out, d + 1); return out; }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const key = pre ? `${pre}.${k}` : k;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out.set(key, v);
    else paths(v, key, out, d + 1);
  }
  return out;
}

console.log('\n=== 各端点里带 pnl / cost / realiz / profit / roi 的字段 ===');
for (const [path, body] of bodies) {
  const p = paths(body);
  const money = [...p].filter(([k]) => /pnl|cost|realiz|profit|roi|gain|basis|invest/i.test(k));
  if (money.length) {
    console.log(`\n--- ${path}`);
    for (const [k, v] of money) console.log(`    ${k.padEnd(52)} ${JSON.stringify(v)}`);
  }
}

// /hodlers/top 的完整持有人字段，逐个列出，用来核对 pnl/realizedPnl/unrealizedPnl/costBasis 的关系
const top = bodies.get('/hodlers/top') as any;
const entry = Array.isArray(top?.responseObject)
  ? top.responseObject.find((e: any) => String(e?.tokenAddress).toLowerCase() === CA.toLowerCase()) ?? top.responseObject[0]
  : null;
if (entry) {
  console.log(`\n=== /hodlers/top 该币条目 ===`);
  console.log('  tokenAddress', entry.tokenAddress, ' networkId', entry.networkId, ' totalHolders', entry.totalHolders);
  console.log('  条目自身的其他键:', Object.keys(entry).filter(k => !['topHolders'].includes(k)).join(', '));
  const h = entry.topHolders?.[0];
  if (h) {
    console.log('\n  单个持有人的全部键:', Object.keys(h).join(', '));
    console.log('  user 的全部键     :', Object.keys(h.user ?? {}).join(', '));
    console.log('\n  前 10 名的收益字段：');
    for (const x of (entry.topHolders ?? []).slice(0, 10)) {
      const pick = (k: string) => (x?.[k] ?? x?.user?.[k] ?? null);
      console.log(`    #${String(x.rank ?? '?').padStart(2)} ${String(x.user?.displayName ?? '?').slice(0, 16).padEnd(17)}` +
        ` amount=${String(pick('humanAmount')).padEnd(16)} pnl=${String(pick('pnl')).padEnd(14)}` +
        ` realized=${String(pick('realizedPnl')).padEnd(14)} unrealized=${String(pick('unrealizedPnl')).padEnd(14)} cost=${pick('costBasis')}`);
    }
  }
  writeFileSync(`${OUT}hodlers-top-sample.json`, JSON.stringify(entry, null, 2));
  console.log(`\n  已保存脱敏样本 -> docs/evidence/hodlers-top-sample.json`);
}
writeFileSync(`${OUT}endpoints.json`, JSON.stringify({ ca: CA, at: Date.now(), hits: [...hits], failures }, null, 2));
await ctx.close();
process.exit(0);
