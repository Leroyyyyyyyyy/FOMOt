/**
 * 侦察 FOMO 前端到底请求了哪些接口，以及每个接口能提取出多少条记录。
 * 输出用来给 scraper 做精确映射（或确认启发式已经够用）。
 */
import { createFomoProvider, endpointReport } from '../src/fomo/scraper.js';
import { db } from '../src/db.js';

console.log('打开会话并浏览 fomo.family…（约 40 秒）');
await createFomoProvider();
await new Promise(r => setTimeout(r, 40_000));

console.log('\n=== 观察到的 prod-api 接口 ===');
const rows = endpointReport();
if (!rows.length) console.log('  (什么都没抓到——会话可能过期了，重跑 npm run login)');
for (const r of rows) console.log(`  ${String(r.records).padStart(5)} 条 / ${String(r.hits).padStart(3)} 次  ${r.path}`);

console.log('\n=== 入库情况 ===');
console.log('  身份映射 :', (db.prepare('SELECT COUNT(*) n FROM fomo_identities').get() as any).n);
console.log('  榜单条目 :', (db.prepare('SELECT COUNT(*) n FROM fomo_leaderboard').get() as any).n);
for (const r of db.prepare('SELECT rank, handle, followers, pnl_24h FROM fomo_leaderboard ORDER BY rank LIMIT 10').all() as any[]) {
  console.log(`   #${String(r.rank).padStart(3)} ${String(r.handle).padEnd(20)} 粉丝 ${r.followers ?? '-'}  24h ${r.pnl_24h}`);
}
process.exit(0);
