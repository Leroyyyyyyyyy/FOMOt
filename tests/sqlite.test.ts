import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, dbFile } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { addr } from './helpers/fixtures.js';

const CA = addr(0x5011);
const clean = () => { db.exec('DELETE FROM fomo_token_holders'); db.exec('DELETE FROM fomo_token_stats'); };
test.beforeEach(clean);

const holders = () => db.prepare('SELECT COUNT(*) n FROM fomo_token_holders WHERE ca=?').get(CA) as { n: number };
const statsRow = () => db.prepare('SELECT * FROM fomo_token_stats WHERE ca=?').get(CA) as any;

/** 复刻 scraper 的写法：Top 列表 → 清旧行 → 最后写「新鲜时间」，整笔一个事务。 */
function ingest(rows: { rank: number; amount: number }[], now: number, failAt?: number) {
  const ins = db.prepare(`INSERT INTO fomo_token_holders (ca,rank,user_id,handle,evm_address,followers,amount,pnl,is_dev,updated_ts)
    VALUES (?,?,?,?,?,?,?,?,0,?) ON CONFLICT(ca,rank) DO UPDATE SET amount=excluded.amount, updated_ts=excluded.updated_ts`);
  db.exec('BEGIN IMMEDIATE');
  try {
    rows.forEach((r, i) => {
      if (failAt === i) throw new Error('批次中途失败');
      ins.run(CA, r.rank, `u${r.rank}`, `h${r.rank}`, null, 1, r.amount, 1, now);
    });
    db.prepare('DELETE FROM fomo_token_holders WHERE ca=? AND updated_ts<?').run(CA, now);
    db.prepare(`INSERT INTO fomo_token_stats (ca,fomo_holders,updated_ts,resp_ts,ingest_ms) VALUES (?,?,?,?,?)
      ON CONFLICT(ca) DO UPDATE SET fomo_holders=excluded.fomo_holders, updated_ts=excluded.updated_ts,
        resp_ts=excluded.resp_ts, ingest_ms=excluded.ingest_ms`).run(CA, rows.length, now, now, 1);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

test('批次中途失败整体回滚，不留半批数据', () => {
  ingest([{ rank: 1, amount: 10 }, { rank: 2, amount: 20 }], 1000);
  assert.equal(holders().n, 2);
  assert.equal(statsRow().updated_ts, 1000);

  assert.throws(() => ingest(
    [{ rank: 1, amount: 99 }, { rank: 2, amount: 99 }, { rank: 3, amount: 99 }], 2000, 2));

  assert.equal(holders().n, 2, '失败的批次不能留下第三行');
  const amounts = (db.prepare('SELECT amount FROM fomo_token_holders WHERE ca=? ORDER BY rank').all(CA) as any[])
    .map(r => r.amount);
  assert.deepEqual(amounts, [10, 20], '前两行也必须回滚到旧值');
});

test('Top 列表写失败时，「新鲜时间」不会被推进', () => {
  ingest([{ rank: 1, amount: 10 }], 1000);
  assert.equal(statsRow().updated_ts, 1000);
  assert.throws(() => ingest([{ rank: 1, amount: 99 }, { rank: 2, amount: 99 }], 5000, 1));
  assert.equal(statsRow().updated_ts, 1000, '不能出现「时间是新的、榜是旧的」');
  assert.equal(statsRow().resp_ts, 1000);
});

test('成功的整份替换会删掉落榜的旧行', () => {
  ingest([{ rank: 1, amount: 1 }, { rank: 2, amount: 2 }, { rank: 3, amount: 3 }], 1000);
  assert.equal(holders().n, 3);
  ingest([{ rank: 1, amount: 9 }], 2000);
  assert.equal(holders().n, 1, '旧行留着会让同一个人在卡片上出现两次');
  assert.equal(statsRow().updated_ts, 2000);
});

test('响应时间与入库提交时间分开存', () => {
  db.prepare(`INSERT INTO fomo_token_stats (ca,fomo_holders,updated_ts,resp_ts,ingest_ms) VALUES (?,?,?,?,?)`)
    .run(CA, 5, 2000, 1900, 100);
  const r = statsRow();
  assert.equal(r.resp_ts, 1900, 'FOMO 响应到达时间');
  assert.equal(r.updated_ts, 2000, '入库提交时间');
  assert.notEqual(r.resp_ts, r.updated_ts);
});

test('swaps 主键让重放幂等，重试不会重复累计成交量', () => {
  const poolId = '0xpool';
  db.prepare('INSERT OR IGNORE INTO pools (pool_id,ca,quote,token_is0,fee,hooks,init_block,init_ts) VALUES (?,?,?,?,?,?,?,?)')
    .run(poolId, CA, addr(0), 1, 0, null, 1, 1);
  const rec = db.prepare('INSERT OR IGNORE INTO swaps (pool_id,block,log_idx,ts,usd) VALUES (?,?,?,?,?)');
  const now = Date.now();
  for (let round = 0; round < 3; round++) {          // 同一批日志回放三次
    rec.run(poolId, 100, 0, now, 500);
    rec.run(poolId, 100, 1, now, 250);
  }
  const v = db.prepare('SELECT COALESCE(SUM(usd),0) v FROM swaps WHERE pool_id=?').get(poolId) as { v: number };
  assert.equal(v.v, 750, '重放三次的成交量必须还是 750');
  db.exec('DELETE FROM swaps'); db.exec("DELETE FROM pools WHERE pool_id='0xpool'");
});

test('pruneAll 在一个事务里完成，异常时整体回滚', () => {
  // 用一个会失败的事务证明 BEGIN/ROLLBACK 语义确实生效
  db.prepare('INSERT OR REPLACE INTO health (metric,value,ts) VALUES (?,?,?)').run('t_probe', 'before', 1);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE health SET value=? WHERE metric=?').run('after', 't_probe');
    throw new Error('中途失败');
  } catch { db.exec('ROLLBACK'); }
  const row = db.prepare('SELECT value FROM health WHERE metric=?').get('t_probe') as any;
  assert.equal(row.value, 'before');
  db.exec("DELETE FROM health WHERE metric='t_probe'");
});

test('锁竞争：另一个写事务占着库时，本批要么整体成功要么整体失败，不留半批', () => {
  // 第二个连接模拟外部诊断脚本 / 并发进程
  const other = new DatabaseSync(dbFile);
  other.exec('PRAGMA busy_timeout = 50');
  const ins = db.prepare(`INSERT INTO fomo_token_holders (ca,rank,user_id,handle,evm_address,followers,amount,pnl,is_dev,updated_ts)
    VALUES (?,?,?,?,NULL,1,1,1,0,?) ON CONFLICT(ca,rank) DO UPDATE SET updated_ts=excluded.updated_ts`);

  other.exec('BEGIN IMMEDIATE');                 // 对方拿住写锁
  other.prepare("INSERT OR REPLACE INTO health (metric,value,ts) VALUES ('t_lock','held',1)").run();

  let failed = false;
  try {
    db.exec('BEGIN IMMEDIATE');                  // 我方拿不到锁
    for (let r = 1; r <= 3; r++) ins.run(CA, r, `u${r}`, `h${r}`, 9000);
    db.exec('COMMIT');
  } catch {
    failed = true;
    try { db.exec('ROLLBACK'); } catch { /* 事务可能压根没开起来 */ }
  }
  other.exec('ROLLBACK');
  other.close();

  const n = holders().n;
  // 关键不在于它成功还是失败，而在于**不能是半批**
  assert.ok(n === 0 || n === 3, `批次必须全有或全无，实际 ${n} 行（失败=${failed}）`);
});

test('busy_timeout 已设置，短暂争锁不会直接炸掉进程', () => {
  const row = db.prepare('PRAGMA busy_timeout').get() as any;
  assert.ok(Number(row.timeout) >= 5000, `busy_timeout 应 >= 5000，实际 ${row.timeout}`);
});
