import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichSocial, type PlatformPnl } from '../src/engine/enrich.js';
import { addr, mutableSnapshot, snapshot, statsFromPnls, stats, holder, leader } from './helpers/fixtures.js';

const plat = (v: number, window: 'live' | 'snapshot' = 'snapshot'): PlatformPnl =>
  ({ value: v, window, asOfTs: Date.now() });

// ── 收益口径 ─────────────────────────────────────────────────────────
// 证据见 docs/FIELDS.md §2.1：/hodlers/top.pnl 是「该币累计收益」，
// 同一用户同一时刻可以与其全平台 24H 收益反号。二者必须分开。

test('该币累计收益与全平台 24H 收益是两个字段，不会互相顶替', () => {
  const out = enrichSocial(18, snapshot(), statsFromPnls(Array(10).fill(5)), []);
  assert.equal(out.top10TokenPnl, 50, '该币累计收益应求和');
  // 没有任何全平台数据源时必须是 null，不能拿该币收益充数
  assert.equal(out.top10PlatformPnl24h, null);
  assert.equal(out.top10PlatformCovered, 0);
  assert.equal(out.top10PlatformWindow, null);
});

test('负收益、零收益都要如实参与该币收益合计与盈利人数', () => {
  const out = enrichSocial(18, snapshot(), statsFromPnls([-100, 0, 10, 10, 10, 10, 10, 10, 10, 10]), []);
  assert.equal(out.top10TokenPnl, -20);
  assert.equal(out.top10TokenProfitable, 8, '零收益不算盈利');
  assert.equal(out.top10Count, 10);
});

test('缺失收益不得包装成完整总和', () => {
  const out = enrichSocial(18, snapshot(), statsFromPnls([1, 1, 1, null, 1, 1, 1, 1, 1, 1]), []);
  assert.equal(out.top10TokenPnl, null, '部分求和必须显示为 n/a');
  assert.equal(out.top10TokenProfitable, null);
  assert.equal(out.top10TokenPnlCovered, 9, '但覆盖率要如实报');
});

test('全平台 24H 收益：十人齐全才给合计，缺一个就是 n/a', () => {
  const s = statsFromPnls(Array(10).fill(1));
  const nine = new Map(s.top.slice(0, 9).map(h => [h.userId!, plat(10)]));
  const partial = enrichSocial(18, snapshot(), s, [], true, new Map(), nine);
  assert.equal(partial.top10PlatformPnl24h, null);
  assert.equal(partial.top10PlatformCovered, 9);

  const all = new Map(s.top.map(h => [h.userId!, plat(10)]));
  const full = enrichSocial(18, snapshot(), s, [], true, new Map(), all);
  assert.equal(full.top10PlatformPnl24h, 100);
  assert.equal(full.top10PlatformWindow, 'snapshot');
});

test('收益窗口不一致时不得求和', () => {
  const s = statsFromPnls(Array(10).fill(1));
  const mixed = new Map(s.top.map((h, i) => [h.userId!, plat(10, i === 0 ? 'live' : 'snapshot')]));
  const out = enrichSocial(18, snapshot(), s, [], true, new Map(), mixed);
  assert.equal(out.top10PlatformPnl24h, null, '混窗口不能相加');
  assert.equal(out.top10PlatformWindow, 'mixed');
});

test('全平台 24H 收益为负也要正确合计', () => {
  const s = statsFromPnls(Array(10).fill(1));
  const all = new Map(s.top.map((h, i) => [h.userId!, plat(i === 0 ? -500 : 10)]));
  const out = enrichSocial(18, snapshot(), s, [], true, new Map(), all);
  assert.equal(out.top10PlatformPnl24h, -410);
});

test('未上盈利榜的用户同样能有全平台 24H 收益', () => {
  // Top10 的 u0..u9 一个都不在榜单上；收益必须来自各自的序列，而不是靠上榜才有
  const s = statsFromPnls(Array(10).fill(1));
  const board = [leader({ userId: 'someone-else' })];
  const all = new Map(s.top.map((h, i) => [h.userId!, plat(i === 0 ? -1_000 : 100)]));
  const out = enrichSocial(18, snapshot(), s, board, true, new Map(), all);
  assert.equal(out.top10PlatformCovered, 10);
  assert.equal(out.top10PlatformPnl24h, -100, '含负收益的未上榜用户也要正确合计');
  assert.equal(out.leaders.length, 0, '榜单上那个人并不持有该币');
});

test('榜单用户的实时口径收益与未上榜用户的整点口径不能混着求和', () => {
  const s = statsFromPnls(Array(10).fill(1));
  const mixed = new Map(s.top.map((h, i) => [h.userId!, plat(10, i < 3 ? 'live' : 'snapshot')]));
  const out = enrichSocial(18, snapshot(), s, [], true, new Map(), mixed);
  assert.equal(out.top10PlatformWindow, 'mixed');
  assert.equal(out.top10PlatformPnl24h, null);
});

// ── Top10 集合 ───────────────────────────────────────────────────────

test('Top10 里同一个用户不能占两格', () => {
  const dup = [holder(0), holder(0), ...Array.from({ length: 9 }, (_, i) => holder(i + 1))];
  const out = enrichSocial(18, snapshot(), stats(dup), []);
  assert.equal(out.top10Count, 10);
  const ids = new Set(dup.slice(0, 11).map(h => h.userId));
  assert.equal(ids.size, 10, '构造的样本里确实有重复');
  assert.equal(out.top10TokenPnl, 10, '重复的那个人只计一次');
});

test('不足十人时按实际集合计算，而不是补齐到十', () => {
  const out = enrichSocial(18, snapshot(), statsFromPnls([1, 2, 3]), []);
  assert.equal(out.top10Count, 3);
  assert.equal(out.identified, 3);
  assert.equal(out.top10TokenPnl, 6, '三个人齐全就算齐全');
  assert.equal(out.top10TokenProfitable, 3);
});

test('真实的零人不会被另一个集合的人数替换', () => {
  // fomoHolders 说有 20 个 FOMO 持币人，但 Top 列表是空的——这两件事不一样
  const out = enrichSocial(18, snapshot(), stats([], { fomoHolders: 20 }), []);
  assert.equal(out.top10Count, 0, '实际集合就是 0，不能回填成 10 或 20');
  assert.equal(out.identified, 0);
  assert.equal(out.top10TokenPnl, null, '零人时没有合计可言');
  assert.equal(out.fomoHolders, 20);
});

test('身份完整但收益不完整时，两个覆盖率分别统计', () => {
  const top = Array.from({ length: 10 }, (_, i) => holder(i, { pnl: i < 6 ? 1 : null }));
  const out = enrichSocial(18, snapshot(), stats(top), []);
  assert.equal(out.identified, 10, '身份覆盖是满的');
  assert.equal(out.top10TokenPnlCovered, 6, '收益覆盖只有 6');
  assert.equal(out.top10TokenPnl, null);
});

// ── 盈利榜交集 ───────────────────────────────────────────────────────

test('盈利榜交集按链上余额匹配，并标注身份是否已确认', () => {
  const { snap, balances } = mutableSnapshot();
  const outside = addr(50);
  balances.set(outside, 7n * 10n ** 18n);
  const board = [leader({ rank: 28, userId: 'outside', handle: 'frank', evmAddress: outside, pnl24h: 323_150 })];
  const out = enrichSocial(18, snap, statsFromPnls(Array(10).fill(1)), board);
  assert.equal(out.leaders.length, 1);
  assert.equal(out.leaders[0]?.balance, 7);
  assert.equal(out.leaders[0]?.identityConfirmed, true);
});

test('只有已确认的钱包映射才参与榜单交集', () => {
  const { snap, balances } = mutableSnapshot();
  const wallet = addr(60);
  balances.set(wallet, 12n * 10n ** 18n);
  const board = [leader({ rank: 70, userId: 'learned', handle: 'learned', evmAddress: addr(61), pnl24h: -500 })];

  // 未确认（候选不传进来）→ 链上对不上，也不在该币持有人表里 → 不计入
  const without = enrichSocial(18, snap, statsFromPnls(Array(10).fill(1)), board);
  assert.equal(without.leaders.length, 0, '候选映射不得当成身份使用');

  // 已确认 → 计入
  const withConfirmed = enrichSocial(18, snap, statsFromPnls(Array(10).fill(1)), board, true,
    new Map([['learned', [wallet]]]));
  assert.equal(withConfirmed.leaders.length, 1);
  assert.equal(withConfirmed.leaders[0]?.balance, 12);
});

test('榜单交集按 userId 去重，显示名不是主键', () => {
  const { snap, balances } = mutableSnapshot();
  balances.set(addr(70), 5n * 10n ** 18n);
  balances.set(addr(71), 5n * 10n ** 18n);
  const board = [
    leader({ rank: 3, userId: 'same', handle: '张三', evmAddress: addr(70) }),
    leader({ rank: 9, userId: 'same', handle: '张三', evmAddress: addr(71) }),   // 同一人两条榜单行
    leader({ rank: 11, userId: 'other', handle: '张三', evmAddress: addr(70) }), // 同名不同人
  ];
  const out = enrichSocial(18, snap, statsFromPnls(Array(10).fill(1)), board);
  assert.equal(out.leaders.length, 2, '同一 userId 只算一次，同名不同 userId 算两个人');
  assert.deepEqual(out.leaders.map(l => l.rank), [3, 11]);
});

test('多个已确认钱包的余额要合并到同一个人名下', () => {
  const { snap, balances } = mutableSnapshot();
  balances.set(addr(80), 3n * 10n ** 18n);
  balances.set(addr(81), 4n * 10n ** 18n);
  const board = [leader({ rank: 5, userId: 'multi', handle: 'multi', evmAddress: null })];
  const out = enrichSocial(18, snap, statsFromPnls(Array(10).fill(1)), board, true,
    new Map([['multi', [addr(80), addr(81)]]]));
  assert.equal(out.leaders[0]?.balance, 7, '两个钱包合并，不是各算一次');
  assert.equal(out.leaders.length, 1);
});

test('拿不到 FOMO 数据时一切归空，不产生任何数字', () => {
  const out = enrichSocial(18, snapshot(), null, []);
  assert.equal(out.available, false);
  assert.equal(out.top10TokenPnl, null);
  assert.equal(out.top10PlatformPnl24h, null);
  assert.equal(out.top10Count, 0);
  assert.equal(out.fomoHolders, null);
});
