import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLeaderboard, parseHodlersTop, parseLeaderboardResult, parseHodlersTopResult } from '../src/fomo/api.js';

const wrap = (responseObject: unknown) => ({ success: true, message: 'ok', responseObject, statusCode: 200 });

test('榜单：名次靠数组顺序，下标 +1', () => {
  const rows = parseLeaderboard(wrap({ leaderboard: [
    { id: 'a', displayName: 'A', userHandle: 'a', evmAddress: '0x' + 'a'.repeat(40), followers: 5, pnl24h: 100 },
    { id: 'b', displayName: 'B', userHandle: 'b', evmAddress: null, followers: 1, pnl24h: -20 },
  ] }));
  assert.deepEqual(rows.map(r => [r.rank, r.userId, r.pnl24h]), [[1, 'a', 100], [2, 'b', -20]]);
  assert.equal(rows[0]!.evmAddress, '0x' + 'a'.repeat(40));
});

test('榜单：负的 pnl24h 要保留，不能被过滤掉', () => {
  const rows = parseLeaderboard(wrap({ leaderboard: [{ id: 'x', displayName: 'X', pnl24h: -1234.5, followers: 0 }] }));
  assert.equal(rows[0]?.pnl24h, -1234.5);
});

test('榜单：结构不对 ≠ 数据为空', () => {
  assert.deepEqual(parseLeaderboardResult(wrap({ leaderboard: [] })), { shapeOk: true, rows: [] });
  // 接口改成了对象、或者外壳变了——都必须报成结构不符，而不是「今天没人上榜」
  assert.equal(parseLeaderboardResult(wrap({ nope: { a: 1 } })).shapeOk, false);
  assert.equal(parseLeaderboardResult({ unexpected: 1 }).shapeOk, false);
  assert.equal(parseLeaderboardResult(null).shapeOk, false);
});

test('/hodlers/top：pnl 家族字段原样取出，负值保留', () => {
  const out = parseHodlersTop(wrap([{
    tokenAddress: '0x' + '1'.repeat(40), networkId: 4663, totalHolders: 26741,
    topHolders: [
      { user: { id: 'u1', displayName: 'ogle', userHandle: 'ogle', evmAddress: '0x' + '2'.repeat(40), followers: 9 },
        humanAmount: 10958112.32, pnl: 5635436.57, realizedPnl: -1935550.4, unrealizedPnl: 7570986.97, costBasis: 3722296.61, isDev: false },
      { user: { id: 'u2', displayName: 'x', followers: null }, humanAmount: 1, pnl: -42, isDev: true },
    ],
  }]));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.fomoHolders, 26741);
  assert.equal(out[0]!.top[0]!.pnl, 5635436.57);
  assert.equal(out[0]!.top[1]!.pnl, -42, '负的该币收益必须保留');
  assert.equal(out[0]!.top[1]!.isDev, true);
});

test('/hodlers/top：pnl == realizedPnl + unrealizedPnl（docs/FIELDS.md §2.1 的复算依据）', () => {
  // 这条锁住口径：pnl 是该币「已实现+未实现」的全时段累计，不是全平台 24H 收益
  const realized = -1935550.4, unrealized = 7570986.97;
  const out = parseHodlersTop(wrap([{
    tokenAddress: '0x' + '1'.repeat(40), networkId: 4663, totalHolders: 1,
    topHolders: [{ user: { id: 'u1', displayName: 'a' }, humanAmount: 1,
      pnl: realized + unrealized, realizedPnl: realized, unrealizedPnl: unrealized, isDev: false }],
  }]));
  assert.ok(Math.abs(out[0]!.top[0]!.pnl! - (realized + unrealized)) < 0.01);
});

test('/hodlers/top：非 Robinhood 链的条目由调用方过滤，解析层如实带出 networkId', () => {
  const out = parseHodlersTop(wrap([
    { tokenAddress: '0x' + '1'.repeat(40), networkId: 8453, totalHolders: 5, topHolders: [] },
    { tokenAddress: '0x' + '2'.repeat(40), networkId: 4663, totalHolders: 7, topHolders: [] },
  ]));
  assert.deepEqual(out.map(o => o.networkId), [8453, 4663]);
});

test('/hodlers/top：totalHolders 为 0 且 topHolders 为空是「真的零」，不是解析失败', () => {
  const r = parseHodlersTopResult(wrap([{ tokenAddress: '0x' + '3'.repeat(40), networkId: 4663, totalHolders: 0, topHolders: [] }]));
  assert.equal(r.shapeOk, true);
  assert.equal(r.rows[0]!.fomoHolders, 0);
  assert.equal(r.rows[0]!.top.length, 0);
});

test('/hodlers/top：结构不对时 shapeOk=false', () => {
  assert.equal(parseHodlersTopResult(wrap({ notAnArray: true })).shapeOk, false);
  assert.equal(parseHodlersTopResult('nonsense').shapeOk, false);
});

test('displayName 优先于 userHandle（原版卡片显示的是 displayName）', () => {
  const rows = parseLeaderboard(wrap({ leaderboard: [
    { id: 'f', displayName: 'frank', userHandle: 'frankdegods', pnl24h: 1, followers: 1 }] }));
  assert.equal(rows[0]?.handle, 'frank');
});
