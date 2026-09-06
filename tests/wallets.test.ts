import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { recordAmountCandidates, confirmedWallets, confirmLink, revokeLink, linkCounts } from '../src/engine/wallets.js';
import { addr, mutableSnapshot, stats, holder } from './helpers/fixtures.js';

const CA = addr(0xcafe);
const clean = () => db.exec('DELETE FROM fomo_wallet_links');
test.beforeEach(clean);

/** 让链上余额精确等于 FOMO 报的两位小数金额 */
const withBalances = (pairs: [string, number][]) => {
  const { snap, balances } = mutableSnapshot({ takenTs: 1_000_000 });
  balances.clear();
  for (const [a, amount] of pairs) balances.set(a.toLowerCase(), BigInt(Math.round(amount * 100)) * 10n ** 16n);
  return snap;
};

test('金额匹配只产生候选，绝不自动成为可信映射', () => {
  const snap = withBalances([[addr(1), 100]]);
  const s = stats([holder(0, { amount: 100 })], { takenTs: 1_000_000 });
  const r = recordAmountCandidates(18, snap, s, CA, { now: 1_000_000 });
  assert.equal(r.recorded, 1);
  assert.equal(linkCounts().candidate, 1);
  assert.equal(linkCounts().confirmed, 0);
  assert.equal(confirmedWallets().size, 0, '候选不得进入聚合统计');
});

test('金额碰撞：多个地址命中同一金额时不绑定任何一个', () => {
  const snap = withBalances([[addr(1), 100], [addr(2), 100]]);
  const s = stats([holder(0, { amount: 100 })], { takenTs: 1_000_000 });
  const r = recordAmountCandidates(18, snap, s, CA, { now: 1_000_000 });
  assert.equal(r.ambiguousAmount, 1);
  assert.equal(r.recorded, 0);
  assert.equal(linkCounts().candidate, 0, '两位小数碰撞不能当成身份证据');
});

test('过期快照：两侧采样时间差太大就不产生候选', () => {
  const snap = withBalances([[addr(1), 100]]);
  const s = stats([holder(0, { amount: 100 })], { takenTs: 1_000_000 + 10 * 60_000 });
  const r = recordAmountCandidates(18, snap, s, CA, { now: 1_000_000 });
  assert.equal(r.staleSnapshot, true);
  assert.equal(r.recorded, 0);
});

test('冲突映射被隔离：同一地址落到两个 userId 时两边都不算数', () => {
  const snap = withBalances([[addr(1), 100]]);
  recordAmountCandidates(18, snap, stats([holder(0, { userId: 'alice', amount: 100 })], { takenTs: 1_000_000 }),
    CA, { now: 1_000_000 });
  assert.equal(linkCounts().candidate, 1);

  const r = recordAmountCandidates(18, snap, stats([holder(0, { userId: 'bob', amount: 100 })], { takenTs: 1_000_000 }),
    CA, { now: 1_000_000 });
  assert.equal(r.conflicting, 1);
  assert.equal(linkCounts().conflict, 1, 'alice 那条要被标成冲突');
  assert.equal(linkCounts().candidate, 0);
  assert.equal(confirmedWallets().size, 0);
});

test('跨链同地址不会混淆：chain_id 是主键的一部分', () => {
  confirmLink('u1', addr(9), { evidenceType: 'transfer_trace', src: 'test', chainId: 4663, txHash: '0xaa' });
  confirmLink('u2', addr(9), { evidenceType: 'transfer_trace', src: 'test', chainId: 8453, txHash: '0xbb' });
  assert.deepEqual(confirmedWallets(4663).get('u1'), [addr(9)]);
  assert.deepEqual(confirmedWallets(8453).get('u2'), [addr(9)]);
  assert.equal(confirmedWallets(4663).has('u2'), false, '另一条链的映射不能串进来');
});

test('一个用户多个钱包会被聚成一条，不会重复计数', () => {
  confirmLink('multi', addr(11), { evidenceType: 'transfer_trace', src: 'test', txHash: '0x1' });
  confirmLink('multi', addr(12), { evidenceType: 'transfer_trace', src: 'test', txHash: '0x2' });
  const w = confirmedWallets();
  assert.equal(w.size, 1);
  assert.deepEqual(w.get('multi')?.sort(), [addr(11), addr(12)].sort());
});

test('候选不会覆盖已确认的行', () => {
  confirmLink('u1', addr(1), { evidenceType: 'transfer_trace', src: 'chain', txHash: '0xabc' });
  const snap = withBalances([[addr(1), 100]]);
  recordAmountCandidates(18, snap, stats([holder(0, { userId: 'u1', amount: 100 })], { takenTs: 1_000_000 }),
    CA, { now: 1_000_000 });
  const row = db.prepare('SELECT status, evidence_type, tx_hash FROM fomo_wallet_links WHERE user_id=?').get('u1') as any;
  assert.equal(row.status, 'confirmed');
  assert.equal(row.evidence_type, 'transfer_trace');
  assert.equal(row.tx_hash, '0xabc', '链上证据不能被金额匹配冲掉');
});

test('撤销后不再计入，但历史行保留', () => {
  confirmLink('u1', addr(1), { evidenceType: 'transfer_trace', src: 'chain', txHash: '0x1' });
  assert.equal(confirmedWallets().size, 1);
  revokeLink('u1', addr(1), '证据不成立');
  assert.equal(confirmedWallets().size, 0);
  const row = db.prepare('SELECT status, note FROM fomo_wallet_links WHERE user_id=?').get('u1') as any;
  assert.equal(row.status, 'revoked');
  assert.equal(row.note, '证据不成立');
});

test('确认的映射带完整证据字段', () => {
  confirmLink('u1', addr(1), { evidenceType: 'transfer_trace', src: '/hodlers/top + Transfer 溯源',
    txHash: '0xdeadbeef', logIndex: 3, tokenCa: CA, now: 12345 });
  const row = db.prepare('SELECT * FROM fomo_wallet_links WHERE user_id=?').get('u1') as any;
  assert.equal(row.evidence_type, 'transfer_trace');
  assert.equal(row.evidence_src, '/hodlers/top + Transfer 溯源');
  assert.equal(row.tx_hash, '0xdeadbeef');
  assert.equal(row.log_index, 3);
  assert.equal(row.chain_id, 4663);
  assert.equal(row.verified_ts, 12345);
  assert.equal(row.observed_ts, 12345);
});

test('迁移进来的历史推断记录是 candidate，不会被当成已验证', () => {
  db.prepare(`INSERT INTO fomo_wallet_links
    (user_id,address,chain_id,status,evidence_type,evidence_src,observed_ts,note)
    VALUES ('old',?,4663,'candidate','amount_match_legacy','fomo_trade_wallets 迁移',1,'历史推断')`).run(addr(77));
  assert.equal(confirmedWallets().has('old'), false);
  assert.equal(linkCounts().candidate, 1);
});
