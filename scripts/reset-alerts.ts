import { db } from '../src/db.js';
db.exec('DELETE FROM alerts; DELETE FROM holder_snapshots;');
console.log('已清空 alerts / holder_snapshots');
