/**
 * 本轮（2026-09-06）整改的验收汇总：把四个任务的验收点各自打一行出来。
 * 只读数据库，不做任何网络调用。用法：FOMOT_DB=… npx tsx scripts/acceptance-v2.ts [分钟]
 */
import { readFileSync } from 'node:fs';
import { db, dbFile } from '../src/db.js';

/**
 * 卡片正文要从 jsonl 记录器读，不能读 `notification_log.detail`——
 * 那一列按 500 字截断，Top10 那两行正好被切掉。
 */
function cards(): { ca: string; triggerTs: number; op: string; ts: number; detail: string }[] {
  try {
    return readFileSync(`${dbFile.replace(/\.db$/, '')}.notifications.jsonl`, 'utf8')
      .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

const minutes = Number(process.argv[2] ?? 120);
const since = Date.now() - minutes * 60_000;
const one = (sql: string, ...args: any[]) => (db.prepare(sql).get(...args) as any);
const all = (sql: string, ...args: any[]) => db.prepare(sql).all(...args) as any[];

console.log(`\n=== 底线检查（最近 ${minutes} 分钟）===`);
const tg = one("SELECT COUNT(*) n FROM notification_log WHERE mode='telegram'").n;
console.log(`  Telegram 网络操作            : ${tg}  ${tg === 0 ? '✅' : '❌'}`);
for (const r of all("SELECT mode, op, ok, COUNT(*) n FROM notification_log WHERE ts>=? GROUP BY mode,op,ok", since)) {
  console.log(`  通知 mode=${r.mode} ${String(r.op).padEnd(7)} ok=${r.ok}  ${r.n}`);
}

console.log('\n=== 告警终态 ===');
for (const r of all("SELECT status, COALESCE(collection_state,'-') cs, COALESCE(pnl_state,'-') ps, COUNT(*) n FROM alerts WHERE trigger_ts>=? GROUP BY status,cs,ps", since)) {
  console.log(`  ${String(r.status).padEnd(16)} 采集=${String(r.cs).padEnd(9)} pnl=${String(r.ps).padEnd(8)} ${r.n}`);
}
const stuck = one("SELECT COUNT(*) n FROM alerts WHERE pnl_state='pending' AND pnl_deadline_ts < ?", Date.now()).n;
console.log(`  过期仍 pending 的 PnL 任务   : ${stuck}  ${stuck === 0 ? '✅' : '⚠️'}`);

/** 任务四：偏移只由持币采集阶段决定 —— 用 holder_snapshots 的 taken_ts 直接核对 */
console.log('\n=== 任务四：持币偏移 vs 卡片更新时刻 ===');
console.log('  代币        初值偏移     复核偏移   最后一次改写相对触发   差值(=PnL 等待，不进偏移)');
for (const a of all(`SELECT ca, trigger_ts FROM alerts WHERE trigger_ts>=? ORDER BY trigger_ts DESC LIMIT 15`, since)) {
  const sym = one('SELECT symbol FROM tokens WHERE ca=?', a.ca)?.symbol ?? '?';
  const i = one("SELECT taken_ts FROM holder_snapshots WHERE ca=? AND trigger_ts=? AND stage='initial'", a.ca, a.trigger_ts);
  const r = one("SELECT taken_ts FROM holder_snapshots WHERE ca=? AND trigger_ts=? AND stage='recheck'", a.ca, a.trigger_ts);
  const last = one("SELECT MAX(ts) ts FROM notification_log WHERE ca=? AND trigger_ts=? AND op='edit'", a.ca, a.trigger_ts);
  if (!i) continue;
  const f = (ms: number | null) => ms === null ? '     -' : `${(ms / 1000).toFixed(1)}s`.padStart(8);
  const reOff = r ? r.taken_ts - a.trigger_ts : null;
  const cardOff = last?.ts ? last.ts - a.trigger_ts : null;
  console.log(`  ${sym.padEnd(10)} ${f(i.taken_ts - a.trigger_ts)} ${f(reOff)} ${f(cardOff)}        ` +
    `${reOff !== null && cardOff !== null ? `${((cardOff - reOff) / 1000).toFixed(1)}s` : '-'}`);
}

/** 任务一/二：卡片正文里的两行收益 —— 直接从通知记录取，看到的就是发出去的字 */
console.log('\n=== 任务一/二：卡片上的两行收益（取每条告警最后一次改写）===');
for (const a of all(`SELECT ca, trigger_ts FROM alerts WHERE trigger_ts>=? ORDER BY trigger_ts DESC LIMIT 15`, since)) {
  const sym = one('SELECT symbol FROM tokens WHERE ca=?', a.ca)?.symbol ?? '?';
  const rows = cards().filter(c => c.ca === a.ca && c.triggerTs === a.trigger_ts && c.op === 'edit');
  const n = rows[rows.length - 1];
  if (!n?.detail) continue;
  const plain = String(n.detail).replace(/<[^>]+>/g, '');
  const token = plain.split('\n').find(l => l.includes('该币累计收益'))?.trim();
  const plat = plain.split('\n').find(l => l.includes('全平台24H PnL'))?.trim();
  const deg = plain.split('\n').find(l => l.includes('数据时点'))?.trim();
  console.log(`  ${sym}`);
  console.log(`     ${token}`);
  console.log(`     ${plat}`);
  if (deg) console.log(`     ${deg}`);
}

console.log('\n=== 任务三：分阶段耗时（P50 / P95 / 最大，稳态）===');
for (const name of ['holder_queue_wait_ms', 'holder_run_ms', 'nav_queue_wait_ms', 'nav_run_ms',
                    'pnl_batch_ms', 'pnl_user_ms', 'pnl_ready_ms', 'initial_latency_ms',
                    'recheck_lateness_ms', 'card_update_lateness_ms', 'pnl_followup_lateness_ms']) {
  const v = all('SELECT value FROM run_metrics WHERE name=? AND ts>=? AND phase=? ORDER BY value', name, since, 'steady')
    .map(r => r.value);
  if (!v.length) { console.log(`  ${name.padEnd(28)} （无采样）`); continue; }
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))]!;
  console.log(`  ${name.padEnd(28)} n=${String(v.length).padStart(5)}  P50=${at(0.5).toFixed(0).padStart(8)}  P95=${at(0.95).toFixed(0).padStart(8)}  max=${v[v.length - 1]!.toFixed(0).padStart(8)}`);
}
console.log('\n=== 任务三：按 kind 分的排队等待（稳态 P95）===');
for (const r of all(`SELECT name, note, COUNT(*) n, MAX(value) mx FROM run_metrics
                     WHERE name IN ('holder_queue_wait_ms','holder_run_ms','nav_queue_wait_ms','nav_run_ms','pnl_user_ms')
                       AND ts>=? AND phase='steady' GROUP BY name, note ORDER BY name, note`, since)) {
  console.log(`  ${String(r.name).padEnd(22)} ${String(r.note ?? '-').padEnd(12)} n=${String(r.n).padStart(5)} max=${r.mx.toFixed(0)}`);
}
