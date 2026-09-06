/**
 * Phase 2 第 5 步验收：用 aggregatedSnapshot 序列复算「全平台 24H 收益」，
 * 拿盈利榜用户、未上榜用户、负收益用户各若干例对照。
 * 只重写页面自己发出的请求的 userId，不读取也不打印任何凭据。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { openContext, FOMO_ORIGIN, isFomoApi } from '../src/fomo/session.js';

const OUT = new URL('../docs/evidence/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());

let board: any[] = [];
let hodlers: any[] = [];
let sub: string | null = null;
const series = new Map<string, any[]>();

await page.route('**/v2/userTokens/aggregatedSnapshot*', async route => {
  const u = new URL(route.request().url());
  if (sub) u.searchParams.set('userId', sub);
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
    } else if (u.pathname === '/v2/userTokens/aggregatedSnapshot') {
      const ro = (await r.json())?.responseObject;
      const id = u.searchParams.get('userId') ?? '';
      if (Array.isArray(ro) && ro.length > (series.get(id)?.length ?? 0)) series.set(id, ro);
    }
  } catch { /* ignore */ }
});

await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(11_000);
await page.goto('https://fomo.family/tokens/robinhood/0x39dbed3a2bd333467115de45665cc57f813c4571',
  { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
await page.waitForTimeout(10_000);
const boardAt = Date.now();
const byId = new Map(board.map((b: any) => [b.id, b]));

const targets = [
  ...board.slice(0, 3).map((b: any) => ({ id: b.id, name: b.displayName, kind: '盈利榜' })),
  ...hodlers.filter((h: any) => !byId.has(h.user?.id)).slice(0, 6).map((h: any) => ({ id: h.user.id, name: h.user.displayName, kind: '未上榜' })),
];

for (const t of targets) {
  sub = t.id;
  await page.goto('about:blank').catch(() => {});
  await page.goto(`${FOMO_ORIGIN}/profile/cosby`, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(6_500);
}
sub = null;

const DAY = 86_400;
const rows: any[] = [];
console.log(`\n榜单抓取于 ${new Date(boardAt).toISOString()}；榜单 ${board.length} 行\n`);
console.log('kind     name                 series  latest_pnl        pnl_24h_ago       delta_24h         榜单 pnl24h        差');
for (const t of targets) {
  const s = series.get(t.id) ?? [];
  if (!s.length) { console.log(`${t.kind.padEnd(8)} ${String(t.name).slice(0,18).padEnd(20)} (无序列)`); continue; }
  const latest = s[s.length - 1];
  const targetSid = latest.snapshotId - DAY;
  // 取不晚于 24h 前的最近一个点
  let prev = s.filter((x: any) => x.snapshotId <= targetSid).pop() ?? s[0];
  const delta = latest.pnl - prev.pnl;
  const lb = byId.get(t.id)?.pnl24h ?? null;
  rows.push({ ...t, latestSid: latest.snapshotId, prevSid: prev.snapshotId, latestPnl: latest.pnl, prevPnl: prev.pnl, delta, lbPnl24h: lb });
  console.log(`${t.kind.padEnd(8)} ${String(t.name).slice(0,18).padEnd(20)} ${String(s.length).padEnd(7)} ` +
    `${latest.pnl.toFixed(2).padEnd(17)} ${prev.pnl.toFixed(2).padEnd(17)} ${delta.toFixed(2).padEnd(17)} ` +
    `${(lb === null ? '—' : lb.toFixed(2)).padEnd(18)} ${lb === null ? '' : (delta - lb).toFixed(2)}`);
}
console.log(`\n负 24H 收益样本: ${rows.filter(r => r.delta < 0).map(r => `${r.name}=${r.delta.toFixed(2)}`).join(', ') || '（本轮样本里没有）'}`);
writeFileSync(`${OUT}verify-24h.json`, JSON.stringify({ boardAt, rows }, null, 2));
await ctx.close();
process.exit(0);
