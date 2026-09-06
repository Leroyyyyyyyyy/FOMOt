/**
 * 关键验证：/v2/userTokens/aggregatedSnapshotById?userId=&snapshotId= 的 pnl
 * 是不是「该用户的全平台 24H 收益」。判据是能否复算盈利榜的 pnl24h。
 *
 * 做法：拦截页面**自己**发出的那个请求，只把 userId 换掉再放行。
 * 这样请求头、TLS 指纹全是应用原样，不需要读取任何凭据；日志与样本里也不会有凭据。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';

const OUT = new URL('../docs/evidence/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());

let board: any[] = [];
let hodlers: any[] = [];
let snapshotId = 0;
let substitute: string | null = null;
const captured: any[] = [];

await page.route('**/v2/userTokens/aggregatedSnapshotById*', async route => {
  const u = new URL(route.request().url());
  if (!snapshotId) snapshotId = Number(u.searchParams.get('snapshotId')) || 0;
  if (substitute) u.searchParams.set('userId', substitute);
  await route.continue({ url: u.toString() });
});

ctx.on('response', async r => {
  if (!isFomoApi(r.url())) return;
  const u = new URL(r.url());
  try {
    if (u.pathname === '/v2/leaderboard/24h' && !board.length) board = (await r.json())?.responseObject?.leaderboard ?? [];
    else if (u.pathname === '/hodlers/top' && !hodlers.length) {
      const ro = (await r.json())?.responseObject;
      hodlers = Array.isArray(ro) ? (ro[0]?.topHolders ?? []) : [];
    } else if (u.pathname === '/v2/userTokens/aggregatedSnapshotById') {
      captured.push({ userId: u.searchParams.get('userId'), snapshotId: u.searchParams.get('snapshotId'),
        status: r.status(), body: (await r.json().catch(() => null))?.responseObject ?? null });
    }
  } catch { /* ignore */ }
});

await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(11_000);
await page.goto('https://fomo.family/tokens/robinhood/0x39dbed3a2bd333467115de45665cc57f813c4571',
  { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
await page.waitForTimeout(11_000);

console.log(`榜单 ${board.length} 行 · Top持有人 ${hodlers.length} 个 · snapshotId=${snapshotId} (${new Date(snapshotId * 1000).toISOString()})`);
if (!snapshotId) { console.log('没拿到 snapshotId'); await ctx.close(); process.exit(1); }

const boardIds = new Set(board.map((b: any) => b.id));
const targets = [
  ...board.slice(0, 3).map((b: any) => ({ id: b.id, name: b.displayName, source: '榜单', ref: b.pnl24h })),
  ...hodlers.filter((h: any) => !boardIds.has(h.user?.id)).slice(0, 3)
    .map((h: any) => ({ id: h.user.id, name: h.user.displayName, source: '未上榜', ref: h.pnl })),
];

for (const t of targets) {
  substitute = t.id;
  await page.goto('about:blank').catch(() => {});
  await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(7_000);
}
substitute = null;

console.log('\n=== 替换 userId 后的 aggregatedSnapshotById 响应 ===');
for (const t of targets) {
  const rows = captured.filter(c => c.userId === t.id);
  console.log(`\n${t.source}  ${t.name}  参照 ${t.source === '榜单' ? 'pnl24h' : '该币 pnl'}=${t.ref}`);
  if (!rows.length) console.log('   （没有捕获到）');
  for (const r of rows) console.log(`   status=${r.status} snapshotId=${r.snapshotId} -> ${JSON.stringify(r.body)}`);
}
writeFileSync(`${OUT}snapshot-pnl-probe.json`, JSON.stringify({ at: Date.now(), snapshotId, targets, captured }, null, 2));
console.log('\n已保存 -> docs/evidence/snapshot-pnl-probe.json（不含任何凭据）');
await ctx.close();
process.exit(0);
