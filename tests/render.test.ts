import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCard, type AlertData } from '../src/notify/render.js';
import { DAY_MS, HOUR_MS } from '../src/engine/pnl.js';
import { addr } from './helpers/fixtures.js';

const END = Math.floor(1_760_000_000_000 / HOUR_MS) * HOUR_MS;
const win = (basis: 'live' | 'snapshot') => ({ basis, startTs: END - DAY_MS, endTs: END });

function card(over: Partial<AlertData> = {}): AlertData {
  return {
    ca: addr(1), symbol: 'MEME', name: 'A Meme Coin',
    marketCapUsd: 126_120, triggerTs: 1_760_000_000_000,
    volume5m: 22_360, volume1h: 212_120,
    initial: { total: 178, fomo: 72, offsetMs: 800 },
    recheck: { total: 491, fomo: 336, offsetMs: 301_000 },
    leaderboardHolders: [], leaderboardAvailable: true, leaderboardPartial: false,
    top10: { tokenPnlTotal: 500, tokenPnlCovered: 10, tokenProfitable: 7,
      platformPnl24h: null, platformProfitable: null, platformCovered: 0, platformWindow: null,
      platformFetchedTs: null, platformState: 'ready', platformReason: '缺 10 人的收益记录',
      identified: 10, count: 10, offsetMs: 301_000 },
    sources: {
      chainBlock: '55121759', chainBlockTs: 1_760_000_000_000, chainTakenTs: 1_760_000_000_500,
      fomoRespTs: 1_760_000_001_000, boardTakenTs: 1_760_000_000_800,
      marketTakenTs: 1_760_000_001_200, sourceSkewMs: 500, degraded: [],
    },
    health: { sourceOk: true, holderCoverage: [49, 336], ingestMs: 64, notifyMode: 'off' },
    ...over,
  };
}
const plain = (d: AlertData) => renderCard(d).replace(/<[^>]+>/g, '');

test('该币累计收益和全平台24H PnL 是两行，标签各不相同', () => {
  const t = plain(card());
  assert.match(t, /该币累计收益（已实现\+未实现）: \+\$500/);
  assert.match(t, /全平台24H PnL: n\/a（0\/10）/);
  // 关键回归：该币收益的数字绝不能出现在「全平台24H PnL」那一行
  const line = t.split('\n').find(l => l.includes('全平台24H PnL'))!;
  assert.ok(!line.includes('500'), `全平台那行不该出现该币收益：${line}`);
});

test('没有全平台收益数据时显示 n/a 与覆盖率，不显示 0', () => {
  const t = plain(card());
  assert.ok(!/全平台24H PnL: \+\$0/.test(t), '缺数据不能显示成零');
  assert.match(t, /全平台24H PnL: n\/a/);
});

test('全平台收益齐全时标出**本口径的**盈利人数与窗口', () => {
  const live = plain(card({ top10: { ...card().top10, platformPnl24h: 500_310, platformProfitable: 7,
    platformCovered: 10, platformWindow: win('live'), platformReason: null } }));
  assert.match(live, /全平台24H PnL: \+\$500\.31K · 盈利 7 人 · 实时口径（截至 /);
  const snap = plain(card({ top10: { ...card().top10, platformPnl24h: -8_880, platformProfitable: 3,
    platformCovered: 10, platformWindow: win('snapshot'), platformReason: null } }));
  assert.match(snap, /全平台24H PnL: -\$8\.88K · 盈利 3 人 · 整点对齐口径（截至 /);
});

test('两行的盈利人数各算各的，不会互相顶替', () => {
  // 该币累计收益为正、盈利 7 人；全平台 24H 为负、盈利只有 2 人
  const t = plain(card({ top10: { ...card().top10, tokenPnlTotal: 1_880_000, tokenProfitable: 7,
    platformPnl24h: -52_360, platformProfitable: 2, platformCovered: 10,
    platformWindow: win('snapshot'), platformReason: null } }));
  const tokenLine = t.split('\n').find(l => l.includes('该币累计收益'))!;
  const platLine = t.split('\n').find(l => l.includes('全平台24H PnL'))!;
  assert.match(tokenLine, /\+\$1\.88M · 盈利 7 人/);
  assert.match(platLine, /-\$52\.36K · 盈利 2 人/);
  assert.ok(!platLine.includes('7 人'), `全平台那行不能出现该币的盈利人数：${platLine}`);
});

test('全平台缺一人时不输出盈利人数，只给覆盖率和原因', () => {
  const t = plain(card({ top10: { ...card().top10, platformPnl24h: null, platformProfitable: null,
    platformCovered: 9, platformReason: '缺 1 人的收益记录' } }));
  const platLine = t.split('\n').find(l => l.includes('全平台24H PnL'))!;
  assert.match(platLine, /n\/a（9\/10）· 缺 1 人的收益记录/);
  assert.ok(!/全平台24H PnL:.*盈利/.test(platLine), '不完整时不能报盈利人数');
});

test('PnL 还在取时显示「采集中」，不是 0 也不是「没有」', () => {
  const t = plain(card({ top10: { ...card().top10, platformState: 'collecting', platformReason: null } }));
  assert.match(t, /全平台24H PnL: 采集中…（0\/10）/);
  assert.ok(!/全平台24H PnL: \+\$0/.test(t));
});

test('数据源时间差超限时卡片给出降级信息', () => {
  const t = plain(card({ sources: { ...card().sources, sourceSkewMs: 300_000,
    degraded: ['链上与 Fomo 采集相差 300s'] } }));
  assert.match(t, /⚠️ 数据时点: 链上与 Fomo 采集相差 300s/);
  assert.ok(!/⚠️ 数据时点/.test(plain(card())), '不超限时不该出现这一行');
});

test('该币收益缺失时显示 n/a 和覆盖率，不做部分求和', () => {
  const t = plain(card({ top10: { ...card().top10, tokenPnlTotal: null, tokenPnlCovered: 9, tokenProfitable: null } }));
  assert.match(t, /该币累计收益（已实现\+未实现）: n\/a（9\/10）/);
  assert.ok(!/盈利 \d+ 人/.test(t), '收益不完整时不能报盈利人数');
});

test('不足十人时分母是实际人数', () => {
  const t = plain(card({ top10: { ...card().top10, identified: 6, count: 6, tokenPnlCovered: 6 } }));
  assert.match(t, /账户识别 6\/6/);
  assert.match(t, /Top10 6\/6/);
});

test('身份覆盖不全时，榜单交集只说「已确认至少 N 人」', () => {
  const holders = [{ rank: 28, handle: 'frank', balance: 11_020_000, followers: 218_710, pnl24h: 323_150, identityConfirmed: true }];
  const partial = plain(card({ leaderboardHolders: holders, leaderboardPartial: true }));
  assert.match(partial, /Fomo 24H盈利榜持有人: 已确认至少 1 人/);
  const full = plain(card({ leaderboardHolders: holders, leaderboardPartial: false }));
  assert.match(full, /Fomo 24H盈利榜持有人: 1 人/);
});

test('覆盖不全且一个都没找到时，说「未发现」而不是「已确认至少 0 人」', () => {
  const t = plain(card({ leaderboardHolders: [], leaderboardPartial: true }));
  assert.match(t, /未发现（身份识别不全，不代表没有）/);
  assert.ok(!/已确认至少 0 人/.test(t));
  // 覆盖完整时的 0 就是真的 0
  assert.match(plain(card({ leaderboardHolders: [], leaderboardPartial: false })), /盈利榜持有人: 0 人/);
});

test('自报持仓的榜单行会被标注出来', () => {
  const t = plain(card({ leaderboardHolders: [
    { rank: 5, handle: 'a', balance: 1, followers: 1, pnl24h: 1, identityConfirmed: false }] }));
  assert.match(t, /持仓据 Fomo 自报/);
});

test('榜单不可用时是 n/a，不是 0 人', () => {
  const t = plain(card({ leaderboardAvailable: false }));
  assert.match(t, /Fomo 24H盈利榜持有人: n\/a/);
  assert.ok(!/盈利榜持有人: 0 人/.test(t));
});

test('禁发送模式会在健康行标出来', () => {
  assert.match(plain(card()), /禁发送演练/);
  assert.ok(!/禁发送演练/.test(plain(card({ health: { ...card().health, notifyMode: 'telegram' } }))));
});

test('持币行缺失时显示「采集中」而不是 0', () => {
  const t = plain(card({ recheck: null }));
  assert.match(t, /持币复核（采集中…）/);
  assert.ok(!/持币复核（\+0\.0s）: 全链 0/.test(t));
});
