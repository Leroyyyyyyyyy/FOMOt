/**
 * 为代表性样本保存可追溯证据：链上区块、各来源时间、聚合结果、渲染出的卡片。
 * 输出全部脱敏——不含凭据，地址与 handle 是公开链上/榜单数据。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '../src/db.js';

const minutes = Number(process.argv[2] ?? 60);
const since = Date.now() - minutes * 60_000;
const OUT = new URL('../docs/run/evidence/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const alerts = db.prepare(`
  SELECT a.ca, a.trigger_ts, a.status, a.collection_state, a.attempts, a.message_id, a.notify_mode, a.last_error
  FROM alerts a WHERE a.trigger_ts >= ? ORDER BY a.trigger_ts DESC`).all(since) as any[];

const samples = alerts.map(a => {
  const snaps = db.prepare('SELECT stage, taken_ts, total_holders, fomo_holders, payload FROM holder_snapshots WHERE ca=? AND trigger_ts=?')
    .all(a.ca, a.trigger_ts) as any[];
  const token = db.prepare('SELECT symbol, name, decimals, total_supply FROM tokens WHERE ca=?').get(a.ca) as any;
  const fomoStats = db.prepare('SELECT fomo_holders, updated_ts, resp_ts, ingest_ms FROM fomo_token_stats WHERE ca=?').get(a.ca) as any;
  const top = db.prepare(`SELECT rank, user_id, handle, evm_address, followers, amount, pnl, is_dev, updated_ts
    FROM fomo_token_holders WHERE ca=? ORDER BY rank LIMIT 10`).all(a.ca) as any[];
  const notifs = db.prepare('SELECT ts, mode, op, message_id, ok, substr(detail,1,4000) detail FROM notification_log WHERE ca=? AND trigger_ts=? ORDER BY id')
    .all(a.ca, a.trigger_ts) as any[];
  return {
    alert: a,
    token,
    stages: snaps.map(s => ({ ...s, payload: JSON.parse(s.payload ?? '{}') })),
    fomoSource: fomoStats,
    top10: top,
    notifications: notifs,
    // 复算依据：Top10 该币累计收益合计与盈利人数，任何人拿这份 JSON 都能重算
    recompute: {
      top10TokenPnlSum: top.every(t => t.pnl !== null) ? top.reduce((s, t) => s + t.pnl, 0) : null,
      top10Profitable: top.every(t => t.pnl !== null) ? top.filter(t => t.pnl > 0).length : null,
      top10Count: top.length,
      identified: top.filter(t => t.user_id || t.handle || t.evm_address).length,
      platformPnl24h: null,
      platformNote: process.env.FOMO_PLATFORM_PNL === '0'
        ? '全平台 24H 收益已被 FOMO_PLATFORM_PNL=0 关闭，故为 n/a'
        : '全平台 24H 收益默认开启，只在复核阶段取；此处不重算，见卡片正文与 notification_log',
    },
  };
});

writeFileSync(`${OUT}samples.json`, JSON.stringify({ capturedAt: Date.now(), windowMinutes: minutes, samples }, null, 2));
console.log(`已保存 ${samples.length} 条样本 -> docs/run/evidence/samples.json`);
for (const s of samples.slice(0, 12)) {
  const init = s.stages.find((x: any) => x.stage === 'initial');
  const re = s.stages.find((x: any) => x.stage === 'recheck');
  console.log(`\n${s.token?.symbol ?? '?'} ${s.alert.ca.slice(0, 12)}… ${s.alert.status}/${s.alert.collection_state ?? '-'} 通知=${s.alert.notify_mode ?? '-'}`);
  if (init) console.log(`  初值 +${init.taken_ts - s.alert.trigger_ts}ms  全链 ${init.total_holders} · Fomo ${init.fomo_holders}  区块 ${init.payload.chainBlock}`);
  if (re) console.log(`  复核 +${re.taken_ts - s.alert.trigger_ts}ms  全链 ${re.total_holders} · Fomo ${re.fomo_holders}  区块 ${re.payload.chainBlock}`);
  console.log(`  Top10 该币累计收益合计=${s.recompute.top10TokenPnlSum} 盈利=${s.recompute.top10Profitable}人 识别=${s.recompute.identified}/${s.recompute.top10Count}`);
  console.log(`  全平台24H PnL=${s.recompute.platformPnl24h ?? 'n/a'}`);
  console.log(`  通知操作: ${s.notifications.map((n: any) => `${n.mode}/${n.op}`).join(', ') || '（无）'}`);
}
