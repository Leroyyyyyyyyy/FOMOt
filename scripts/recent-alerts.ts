import { db } from '../src/db.js';
const rows = db.prepare('SELECT ca, trigger_ts, message_id, status, recheck_due_ts, last_error FROM alerts ORDER BY trigger_ts DESC LIMIT 12').all() as any[];
for (const r of rows) {
  const sym = (db.prepare('SELECT symbol FROM tokens WHERE ca = ?').get(r.ca) as any)?.symbol ?? '?';
  console.log(`  ${sym.padEnd(12)} ${Math.round((Date.now()-r.trigger_ts)/1000)}s 前 · ${r.status}${r.last_error ? ` · ${r.last_error}` : ''}`);
}
