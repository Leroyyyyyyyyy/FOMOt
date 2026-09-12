/**
 * post 模式运行报告（设计文档 §14 / §14.1）。
 *
 *   npm run post:report -- --hours 24 [--run live]
 *
 * 只读。刻意把「形态识别」与「收益」分开报：形态识别通过不代表策略有正收益，
 * 所以这里报触发数、拒绝原因、失效率、覆盖缺口、消息可靠性和延迟分位数，
 * **不给任何收益结论**——那需要有观测期的样本和明确的执行假设。
 */
import { db } from '../src/db.js';
import { migratePostSchema } from '../src/post/store.js';
import { openGaps } from '../src/post/market/coverage.js';
import { outboxStats, pendingReconcile } from '../src/post/outbox.js';
import { candidateCounts } from '../src/post/discovery.js';

migratePostSchema();

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const hours = Number(arg('hours', '24'));
const runId = arg('run', 'live')!;
const chainId = Number(arg('chain', '4663'));
const since = Date.now() - hours * 3600_000;
const line = (s = '─') => console.log(s.repeat(72));

console.log(`\npost_v1 运行报告 · 最近 ${hours}h · runId ${runId} · chain ${chainId}`);
console.log(new Date().toISOString());
line();

// ── 候选与覆盖
const tiers = candidateCounts(chainId);
console.log(`候选        hot ${tiers.hot} · warm ${tiers.warm} · cold ${tiers.cold}`);
console.log('            （200 hot / 1000 warm 是目标容量，不是本次已跑到的规模）');
const gaps = openGaps(chainId, 1000);
console.log(`覆盖缺口    ${gaps.length} 段未补${gaps.length ? '（缺口补齐前不得发形态确认）' : ''}`);

const candleQ = db.prepare(
  `SELECT timeframe_sec tf, quality, synthetic, COUNT(*) n FROM post_candles
   WHERE open_ts >= ? GROUP BY tf, quality, synthetic ORDER BY tf`,
).all(since) as any[];
if (candleQ.length) {
  console.log('K 线质量：');
  for (const r of candleQ) {
    console.log(`  ${String(r.tf).padStart(4)}s  ${r.quality.padEnd(9)} ${r.synthetic ? 'synthetic' : '真实/混合'} ${r.n}`);
  }
}
const unpriced = (db.prepare("SELECT COUNT(*) n FROM post_swaps WHERE quote_quality='missing' AND event_ts >= ?").get(since) as any).n;
console.log(`未定价成交  ${unpriced}（报价缺口，已保留原始日志待补算）`);

// ── episode 与信号
line();
const eps = db.prepare(
  `SELECT strategy, state, COUNT(*) n FROM post_episodes WHERE run_id=? AND updated_at >= ? GROUP BY strategy, state`,
).all(runId, since) as any[];
console.log('episode 状态分布：');
if (!eps.length) console.log('  （无）');
for (const e of eps) console.log(`  ${e.strategy.padEnd(16)} ${e.state.padEnd(22)} ${e.n}`);

const sigs = db.prepare(
  `SELECT event_type, COUNT(*) n FROM post_signals WHERE run_id=? AND confirmed_at >= ? GROUP BY event_type ORDER BY n DESC`,
).all(runId, since) as any[];
line();
console.log('信号：');
if (!sigs.length) console.log('  （无）');
for (const s of sigs) console.log(`  ${s.event_type.padEnd(28)} ${s.n}`);

// 观察到确认率 / 失效率（分母是 READY，不是全部候选）
const n = (t: string) => (db.prepare(
  `SELECT COUNT(*) n FROM post_signals WHERE run_id=? AND confirmed_at >= ? AND event_type=?`,
).get(runId, since, t) as any).n;
const ready = n('SECOND_LEG_READY'), breakout = n('SECOND_LEG_BREAKOUT');
const invalid = n('SECOND_LEG_INVALIDATED'), expired = n('SECOND_LEG_EXPIRED');
if (ready) {
  console.log(`  二段：READY ${ready} → 突破 ${breakout}（${(breakout / ready * 100).toFixed(0)}%）` +
    ` · 失效 ${invalid} · 过期 ${expired}`);
  console.log('  注：观测期不足的样本应记 censored，这里的比率只是当期计数，不是策略胜率。');
}

// ── 拒绝原因（回答「为什么没推」）
line();
const rejects = db.prepare(
  `SELECT rule, result, COUNT(*) n FROM post_evaluations
   WHERE run_id=? AND as_of >= ? AND result != 'pass' GROUP BY rule, result ORDER BY n DESC LIMIT 25`,
).all(runId, since) as any[];
console.log('未通过 / 未知的规则（Top 25）：');
if (!rejects.length) console.log('  （无）');
for (const r of rejects) console.log(`  ${r.result === 'fail' ? '❌' : '⚠️ '} ${r.rule.padEnd(30)} ${r.n}`);

// ── 消息可靠性
line();
const ob = outboxStats(runId);
console.log(`outbox      ${JSON.stringify(ob)}`);
console.log(`  已送达 ${ob.sent} · 明确失败 ${ob.failed} · 过期丢弃 ${ob.expired} · **结果未知 ${ob.unknown}**`);
if (ob.unknown) {
  console.log('  ⚠️  结果未知的任务不会自动重发（可能漏通知），需要人工核对：');
  for (const t of pendingReconcile(runId, 10)) {
    console.log(`     ${t.outboxId} signal=${t.signalId} ${t.lastError ?? ''}`);
  }
}
console.log('  端到端「恰好一次」不作承诺：Telegram sendMessage 没有本项目可依赖的客户端幂等键。');
if (ob.expired) console.log(`  过期丢弃 ${ob.expired} 条：逾期不补发成实时信号，这是拥塞的真实代价，不用无限排队换「零失败」。`);

// ── 延迟与资源分位数
line();
const pct = (name: string) => {
  const rows = db.prepare('SELECT value FROM run_metrics WHERE name=? AND ts >= ? ORDER BY value').all(name, since) as any[];
  if (!rows.length) return null;
  const at = (q: number) => rows[Math.min(rows.length - 1, Math.floor((rows.length - 1) * q))]!.value;
  return { n: rows.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: rows[rows.length - 1]!.value };
};
console.log('指标分位数（工程目标：闭合可用桶 → 本地信号 P95 ≤ 2s；1m 收盘 → TG 确认 P95 ≤ 20s）：');
for (const m of ['post_tick_ms', 'post_scan_swaps', 'post_evaluated', 'post_signals', 'post_rss_mb']) {
  const p = pct(m);
  console.log(`  ${m.padEnd(18)} ${p ? `n=${p.n} p50=${fmt(p.p50)} p95=${fmt(p.p95)} p99=${fmt(p.p99)} max=${fmt(p.max)}` : '（无样本）'}`);
}
console.log('  未达目标要如实报告，不能靠改 confirmedAt 掩盖延迟。');

// ── 效果报告的边界
line();
console.log('效果说明（§14.1）：');
console.log('  · 本报告只验证「形态识别与通知链路」，**不给收益结论**。');
console.log('  · 影子交易是可选项，需要注明手续费/税费/滑点与流动性假设；');
console.log('    只有 OHLC 时无法判定同根 K 内止盈止损先后，必须用保守顺序或交易级重放。');
console.log('  · 25% 分批规则原帖没有具体目标价，不能补一个最赚钱的出场阶梯再称帖子收益。');
console.log('  · 历史叙事若是事后补写，必须标 retrospective_narrative，只能研究形态。');
console.log();

function fmt(v: number): string { return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2); }
