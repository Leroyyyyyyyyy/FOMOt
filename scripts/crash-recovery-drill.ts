/**
 * 强制退出恢复演练（隔离环境）。
 *
 * 用独立临时库 + 禁发送模式，真的 SIGKILL 一个子进程，再用新进程跑恢复。
 * 不碰日常运行库，也不抢 Playwright profile。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'fomot-drill-'));
const DB = join(dir, 'drill.db');
const env = { ...process.env, FOMOT_DB: DB, NOTIFY_MODE: 'off', LOG_LEVEL: 'warn' };
const CA = '0x' + 'ab'.repeat(20);

const child = join(dir, 'child.mts');
writeFileSync(child, `
import { db } from '${new URL('../src/db.ts', import.meta.url).pathname}';
import { Notifier } from '${new URL('../src/notify/notifier.ts', import.meta.url).pathname}';
const CA = '${CA}';
const now = Date.now();
const n = new Notifier('off');
// 1) 一条正常的 pending_recheck（卡已发、状态已落库）
const payload = JSON.stringify({ m: { ca: CA, symbol: 'D', name: 'D', decimals: 18,
  marketCapUsd: 1, volume5m: 1, volume1h: 1 }, triggerTs: 1000, initialTotal: 100,
  initE: {}, initialOffsetMs: 800, messageId: 11, originalDueTs: 1000 + 301000,
  recheckDueTs: 1000 + 301000, attempts: 0 });
db.prepare(\`INSERT INTO alerts (ca,trigger_ts,message_id,payload,status,recheck_due_ts,original_due_ts,attempts,collection_state)
  VALUES (?,?,?,?,'pending_recheck',?,?,0,'pending')\`).run(CA, 1000, 11, payload, 1000+301000, 1000+301000);

// 2) 崩溃窗口：卡片发出去了（记录器已写），状态**还没**落库
db.prepare(\`INSERT INTO alerts (ca,trigger_ts,message_id,payload,status,recheck_due_ts,original_due_ts,attempts,collection_state)
  VALUES (?,?,NULL,NULL,'firing',?,?,0,'pending')\`).run(CA, 2000, 2000+301000, 2000+301000);
await n.send('<b>崩溃窗口卡片</b>', {}, { ca: CA, triggerTs: 2000 });

// 3) 从没发出去的 firing 占位行
db.prepare(\`INSERT INTO alerts (ca,trigger_ts,message_id,payload,status,recheck_due_ts,original_due_ts,attempts,collection_state)
  VALUES (?,?,NULL,NULL,'firing',?,?,0,'pending')\`).run(CA, 3000, 3000+301000, 3000+301000);

// 4) 损坏的 payload
db.prepare(\`INSERT INTO alerts (ca,trigger_ts,message_id,payload,status,recheck_due_ts,original_due_ts,attempts,collection_state)
  VALUES (?,?,?,'{坏掉的 JSON','pending_recheck',?,?,0,'pending')\`).run(CA, 4000, 12, 4000+301000, 4000+301000);

console.log('子进程已写入 4 条状态，准备自杀');
process.kill(process.pid, 'SIGKILL');       // 强制退出，没有任何清理机会
`);

console.log('=== 1. 子进程写状态后 SIGKILL ===');
const r1 = spawnSync('npx', ['tsx', child], { env, encoding: 'utf8' });
console.log(r1.stdout.trim());
// npx 会把子孙进程的信号转成退出码 128+9=137，两种表现都算强杀
const killed = r1.signal === 'SIGKILL' || r1.status === 137;
console.log(`子进程信号: ${r1.signal}  退出码: ${r1.status}  → ${killed ? '确认强制退出' : '不是强杀'}`);
if (!killed) { console.error('演练无效：子进程不是被强杀的'); process.exit(1); }

const recover = join(dir, 'recover.mts');
writeFileSync(recover, `
import { db } from '${new URL('../src/db.ts', import.meta.url).pathname}';
import { Engine } from '${new URL('../src/engine/index.ts', import.meta.url).pathname}';
import { nullFomo } from '${new URL('../src/fomo/provider.ts', import.meta.url).pathname}';
import { Notifier } from '${new URL('../src/notify/notifier.ts', import.meta.url).pathname}';
const ac = new AbortController(); ac.abort();          // 只做恢复，不真的跑复核
const e = new Engine(nullFomo, ac.signal, new Notifier('off'));
const first = e.resumePending();
const second = e.resumePending();                       // 重复恢复必须是空操作
console.log(JSON.stringify({ first, second }));
for (const r of db.prepare('SELECT trigger_ts, status, collection_state, last_error FROM alerts ORDER BY trigger_ts').all() as any[]) {
  console.log(\`  trigger_ts=\${r.trigger_ts} status=\${r.status} 采集=\${r.collection_state} err=\${String(r.last_error ?? '').slice(0,60)}\`);
}
const tg = db.prepare("SELECT COUNT(*) n FROM notification_log WHERE mode='telegram'").get() as any;
console.log('telegram 模式的通知记录数:', tg.n);
`);

console.log('\n=== 2. 新进程恢复 ===');
const r2 = spawnSync('npx', ['tsx', recover], { env, encoding: 'utf8' });
console.log(r2.stdout.trim());
if (r2.stderr.trim()) console.log('stderr:', r2.stderr.trim().slice(0, 400));
console.log(`\n临时库: ${DB}`);
