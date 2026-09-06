import { db, getHealth } from '../src/db.js';
const n = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n;
for (const t of ['pools','pool_state','tokens','swaps','alerts','fomo_leaderboard','fomo_token_stats','fomo_token_holders','fomo_identities']) {
  console.log(`  ${t.padEnd(20)} ${n(t)}`);
}
const s = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM swaps').get() as any;
console.log('\nswaps 时间跨度:', s.a ? `${new Date(s.a).toISOString()} → ${new Date(s.b).toISOString()}` : '(空)');
console.log('现在        :', new Date().toISOString());
for (const k of ['chain_source','chain_lag_blocks','chain_last_batch','chain_tick_ms','universe_size','fomo_ingest_ms']) {
  console.log(`  ${k.padEnd(18)}`, getHealth(k)?.value ?? '-');
}
