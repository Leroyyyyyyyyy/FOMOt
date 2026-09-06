import { db } from '../src/db.js';
const rows = db.prepare(`
  SELECT ca, trigger_ts, stage, taken_ts, total_holders, fomo_holders
  FROM holder_snapshots ORDER BY trigger_ts DESC, stage DESC LIMIT 20
`).all() as any[];
const sym = (ca: string) => (db.prepare('SELECT symbol FROM tokens WHERE ca = ?').get(ca) as any)?.symbol ?? '?';
let cur = '';
for (const r of rows) {
  const k = `${r.ca}|${r.trigger_ts}`;
  if (k !== cur) { cur = k; console.log(`\n${sym(r.ca)}  触发于 ${Math.round((Date.now()-r.trigger_ts)/1000)}s 前`); }
  console.log(`   ${r.stage.padEnd(8)} +${((r.taken_ts - r.trigger_ts)/1000).toFixed(1)}s   全链 ${String(r.total_holders).padStart(5)}  Fomo ${r.fomo_holders === null ? 'n/a' : r.fomo_holders}`);
}
