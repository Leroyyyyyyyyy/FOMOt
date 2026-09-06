import { db, getHealth } from '../src/db.js';
import { activeTokens, volumeUsd } from '../src/chain/volume.js';
const n = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n;
console.log('池', n('pools'), '· 代币', n('tokens'), '· Swap', n('swaps'), '· 告警', n('alerts'));
for (const k of ['chain_source','chain_lag_blocks','chain_tick_ms','chain_last_batch','volume_window_complete','pool_backfill','quote_price','fomo_source','universe_size','engine_tick_ms']) {
  console.log(` ${k.padEnd(18)}`, getHealth(k)?.value ?? '-');
}
console.log('候选（5m 有成交）:');
for (const t of activeTokens(5*60_000, 6)) {
  const m = db.prepare('SELECT symbol FROM tokens WHERE ca = ?').get(t.ca) as any;
  console.log(`  ${(m?.symbol ?? '?').padEnd(12)} 5m=$${volumeUsd(t.ca,300_000).toFixed(0)}`);
}
