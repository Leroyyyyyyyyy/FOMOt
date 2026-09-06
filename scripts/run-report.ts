/** 实跑验收报告：指标分位数、告警明细、失败案例。默认统计最近 N 分钟。 */
import { db } from '../src/db.js';

const minutes = Number(process.argv[2] ?? 60);
const since = Date.now() - minutes * 60_000;
const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(1));

function quantiles(name: string, phase?: string) {
  const rows = db.prepare(
    `SELECT value FROM run_metrics WHERE name=? AND ts>=? ${phase ? 'AND phase=?' : ''} ORDER BY value`
  ).all(...(phase ? [name, since, phase] : [name, since])) as { value: number }[];
  if (!rows.length) return null;
  const v = rows.map(r => r.value);
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))]!;
  return { n: v.length, p50: at(0.5), p95: at(0.95), max: v[v.length - 1]! };
}

const METRICS: [string, string][] = [
  ['scan_tick_ms', '候选扫描耗时 (ms)'],
  ['initial_latency_ms', '初值完成延迟 (ms)'],
  ['recheck_lateness_ms', '复核相对原定到期的延迟 (ms)'],
  ['age_chain_ms', '链上数据年龄 (ms)'],
  ['age_fomo_ms', 'FOMO 数据年龄 (ms)'],
  ['age_board_ms', '榜单数据年龄 (ms)'],
  ['chain_lag_blocks', 'RPC 落后区块'],
  ['recheck_attempts', '复核尝试次数'],
  ['unfinished_alerts', '未完成任务数'],
  ['rss_mb', '常驻内存 (MB)'],
  ['heap_mb', '堆内存 (MB)'],
  ['tracked_tokens', '持币缓存代币数'],
];

console.log(`\n=== 实跑指标（最近 ${minutes} 分钟）===`);
console.log('指标'.padEnd(30) + '阶段'.padEnd(10) + 'n'.padStart(6) + 'P50'.padStart(12) + 'P95'.padStart(12) + '最大'.padStart(12));
for (const [name, label] of METRICS) {
  for (const phase of ['startup', 'steady']) {
    const q = quantiles(name, phase);
    if (!q) continue;
    console.log(label.padEnd(30) + (phase === 'startup' ? '启动恢复' : '稳态').padEnd(10) +
      String(q.n).padStart(6) + fmt(q.p50).padStart(12) + fmt(q.p95).padStart(12) + fmt(q.max).padStart(12));
  }
}

const retries = (db.prepare('SELECT COUNT(*) n FROM run_metrics WHERE name=? AND ts>=?').get('recheck_retry', since) as any).n;
console.log(`\n复核重试次数: ${retries}`);

console.log('\n=== 告警状态分布 ===');
for (const r of db.prepare(
  `SELECT status, collection_state, COUNT(*) n FROM alerts WHERE trigger_ts>=? GROUP BY status, collection_state`
).all(since) as any[]) {
  console.log(`  ${String(r.status).padEnd(18)} 采集=${String(r.collection_state ?? '-').padEnd(10)} ${r.n}`);
}

console.log('\n=== 通知操作（禁发送模式应全部 mode=off）===');
for (const r of db.prepare(
  `SELECT mode, op, ok, COUNT(*) n FROM notification_log WHERE ts>=? GROUP BY mode, op, ok`
).all(since) as any[]) {
  console.log(`  mode=${r.mode} ${String(r.op).padEnd(8)} ok=${r.ok} ${r.n}`);
}

console.log('\n=== 完成初值+复核的告警样本 ===');
const done = db.prepare(`
  SELECT a.ca, a.trigger_ts, a.status, a.collection_state, a.attempts,
         i.total_holders it, i.fomo_holders if_, i.taken_ts its,
         r.total_holders rt, r.fomo_holders rf, r.taken_ts rts
  FROM alerts a
  JOIN holder_snapshots i ON i.ca=a.ca AND i.trigger_ts=a.trigger_ts AND i.stage='initial'
  LEFT JOIN holder_snapshots r ON r.ca=a.ca AND r.trigger_ts=a.trigger_ts AND r.stage='recheck'
  WHERE a.trigger_ts>=? ORDER BY a.trigger_ts DESC`).all(since) as any[];
console.log(`  共 ${done.length} 条有初值快照，其中 ${done.filter(d => d.rts).length} 条完成复核`);
for (const d of done.slice(0, 15)) {
  console.log(`  ${d.ca.slice(0, 12)}… ${d.status}/${d.collection_state ?? '-'} 尝试${d.attempts}` +
    ` 初值 +${d.its - d.trigger_ts}ms 全链${d.it}/Fomo${d.if_}` +
    (d.rts ? ` · 复核 +${d.rts - d.trigger_ts}ms 全链${d.rt}/Fomo${d.rf}` : ' · 复核未完成'));
}

console.log('\n=== 钱包映射状态 ===');
for (const r of db.prepare('SELECT status, evidence_type, COUNT(*) n FROM fomo_wallet_links GROUP BY status, evidence_type').all() as any[]) {
  console.log(`  ${String(r.status).padEnd(12)} ${String(r.evidence_type).padEnd(22)} ${r.n}`);
}

console.log('\n=== 健康位 ===');
for (const r of db.prepare('SELECT metric, value, ts FROM health ORDER BY metric').all() as any[]) {
  console.log(`  ${r.metric.padEnd(26)} ${String(r.value).padEnd(14)} ${Math.round((Date.now() - r.ts) / 1000)}s 前`);
}
