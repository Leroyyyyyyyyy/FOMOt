import { db } from '../src/db.js';
const rows = db.prepare('SELECT ca, fomo_holders, updated_ts FROM fomo_token_stats ORDER BY updated_ts DESC').all() as any[];
console.log('fomo_token_stats 全表:');
for (const r of rows) {
  const holders = (db.prepare('SELECT COUNT(*) n FROM fomo_token_holders WHERE ca = ?').get(r.ca) as any).n;
  const sym = (db.prepare('SELECT symbol FROM tokens WHERE ca = ?').get(r.ca) as any)?.symbol ?? '?';
  console.log(`  ${sym.padEnd(12)} ${r.ca}  Fomo持有人=${String(r.fomo_holders).padStart(6)}  Top入库=${holders}  ${Math.round((Date.now()-r.updated_ts)/1000)}s 前`);
}
