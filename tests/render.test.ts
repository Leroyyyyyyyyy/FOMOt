import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCard, type AlertData } from '../src/notify/render.js';
import { addr } from './helpers/fixtures.js';

function card(over: Partial<AlertData> = {}): AlertData {
  return {
    ca: addr(1), symbol: 'MEME', name: 'A Meme Coin',
    marketCapUsd: 126_120, triggerTs: 1_760_000_000_000,
    volume5m: 22_360, volume1h: 212_120,
    initial: { total: 178, fomo: 72, offsetMs: 800 },
    recheck: { total: 491, fomo: 336, offsetMs: 301_000 },
    leaderboardHolders: [], leaderboardAvailable: true, leaderboardPartial: false,
    top10: { tokenPnlTotal: 500, tokenPnlCovered: 10, tokenProfitable: 7,
      platformPnl24h: null, platformCovered: 0, platformWindow: null,
      identified: 10, count: 10, offsetMs: 301_000 },
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

test('全平台收益齐全时标出窗口口径', () => {
  const live = plain(card({ top10: { ...card().top10, platformPnl24h: 500_310, platformCovered: 10, platformWindow: 'live' } }));
  assert.match(live, /全平台24H PnL: \+\$500\.31K · 实时口径/);
  const snap = plain(card({ top10: { ...card().top10, platformPnl24h: -8_880, platformCovered: 10, platformWindow: 'snapshot' } }));
  assert.match(snap, /全平台24H PnL: -\$8\.88K · 整点对齐口径/);
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
