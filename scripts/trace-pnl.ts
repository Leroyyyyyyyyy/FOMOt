/**
 * 全平台 24H 收益的**可追溯样例**：
 *   逐人序列输入 → 窗口校验 → 逐人收益 → 总收益/盈利人数 → 渲染出的那一行。
 *
 * 每一步都打出中间量，任何人都能拿这份输出独立复算卡片上的数字。
 * 输入是构造的（不依赖网络也不依赖登录态），但走的是**生产代码路径**：
 * `deriveRecord` / `aggregatePnl` / `enrichSocial` / `renderCard` 都是线上那几个函数。
 *
 *   npx tsx scripts/trace-pnl.ts            # 打印
 *   npx tsx scripts/trace-pnl.ts --write    # 另存 docs/run/evidence/pnl-trace.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  aggregatePnl, deriveRecord, targetWindow, DAY_MS, HOUR_MS, MISS_TEXT,
  type PnlRecord,
} from '../src/engine/pnl.js';
import { enrichSocial } from '../src/engine/enrich.js';
import { renderCard, type AlertData } from '../src/notify/render.js';

const NOW = Math.floor(Date.now() / HOUR_MS) * HOUR_MS + 7 * 60_000;   // 整点后 7 分钟
const WINDOW = targetWindow(NOW);
const FETCHED = NOW + 41_000;

/**
 * 十个人的**原始输入**：每人一条逐小时累计收益序列。
 * 前九个人齐全，第十个人故意只给到 23 小时——用来演示「起点缺失就判缺失」。
 */
const INPUT: { userId: string; handle: string; startPnl: number; endPnl: number; hours: number }[] = [
  { userId: 'u0', handle: 'Unipcs',   startPnl: 16_053_435.47, endPnl: 16_553_435.47, hours: 30 },
  { userId: 'u1', handle: 'ogle',     startPnl: 4_210_000.00,  endPnl: 4_330_000.00,  hours: 30 },
  { userId: 'u2', handle: 'Binkieee', startPnl: 902_300.00,    endPnl: 849_940.00,    hours: 30 },
  { userId: 'u3', handle: 'looc',     startPnl: 120_000.00,    endPnl: 120_000.00,    hours: 30 },
  { userId: 'u4', handle: 'memeunc',  startPnl: 55_000.00,     endPnl: 85_000.00,     hours: 30 },
  { userId: 'u5', handle: 'Avast',    startPnl: 990.00,        endPnl: 1_000.00,      hours: 30 },
  { userId: 'u6', handle: 'Rowdy',    startPnl: 400.00,        endPnl: 397.00,        hours: 30 },
  { userId: 'u7', handle: 'frank',    startPnl: 12_000.00,     endPnl: 19_000.00,     hours: 30 },
  { userId: 'u8', handle: 'cosby',    startPnl: 8_500.00,      endPnl: 11_000.00,     hours: 30 },
  { userId: 'u9', handle: 'Yaoza',    startPnl: 300.00,        endPnl: 301.00,        hours: 23 },
];

/** 造一条逐小时序列：两端锚在给定值上，中间线性插值。 */
function series(row: typeof INPUT[number]) {
  const out: { snapshotId: number; pnl: number }[] = [];
  for (let i = row.hours; i >= 0; i--) {
    const ts = WINDOW.endTs - i * HOUR_MS;
    const frac = (row.hours - i) / row.hours;
    const pnl = i === 0 ? row.endPnl
      : ts === WINDOW.startTs ? row.startPnl
      : row.startPnl + (row.endPnl - row.startPnl) * frac;
    out.push({ snapshotId: ts / 1000, pnl: Math.round(pnl * 100) / 100 });
  }
  return out;
}

const iso = (ts: number) => new Date(ts).toISOString();

console.log('\n=== ① 目标窗口（一次聚合只定一次，十个人共用）===');
console.log(`  口径      : ${WINDOW.basis}`);
console.log(`  窗口开始  : ${iso(WINDOW.startTs)}`);
console.log(`  窗口结束  : ${iso(WINDOW.endTs)}`);
console.log(`  区间长度  : ${(WINDOW.endTs - WINDOW.startTs) / HOUR_MS} 小时（必须 = ${DAY_MS / HOUR_MS}）`);
console.log(`  获取时间  : ${iso(FETCHED)}  ← 与窗口结束时间是两个字段`);

console.log('\n=== ② 逐人序列 → 窗口校验 → 收益 ===');
console.log('用户'.padEnd(10) + '点数'.padStart(6) + '起点 pnl'.padStart(18) + '终点 pnl'.padStart(18) + '24H 收益'.padStart(16) + '  结果');
const records = new Map<string, PnlRecord>();
const misses: { userId: string; reason: string }[] = [];
const perUser = INPUT.map(row => {
  const raw = series(row);
  const r = deriveRecord(row.userId, raw, WINDOW, FETCHED);
  const startPoint = raw.find(p => p.snapshotId === WINDOW.startTs / 1000);
  const endPoint = raw.find(p => p.snapshotId === WINDOW.endTs / 1000);
  if (r.ok) records.set(row.userId, r.record);
  else misses.push({ userId: row.userId, reason: MISS_TEXT[r.reason] });
  console.log(
    `${row.handle}`.padEnd(10) + String(raw.length).padStart(6) +
    (startPoint ? startPoint.pnl.toFixed(2) : '缺失').padStart(18) +
    (endPoint ? endPoint.pnl.toFixed(2) : '缺失').padStart(18) +
    (r.ok ? r.record.value.toFixed(2) : 'n/a').padStart(16) +
    `  ${r.ok ? '✅ 记录成立' : `❌ ${MISS_TEXT[r.reason]}`}`);
  return {
    userId: row.userId, handle: row.handle, seriesPoints: raw.length,
    startPoint: startPoint ?? null, endPoint: endPoint ?? null,
    record: r.ok ? r.record : null, miss: r.ok ? null : r.reason,
  };
});

console.log('\n=== ③ 聚合校验（成员完整 / 数值有效 / 口径一致 / 窗口一致）===');
const memberIds = INPUT.map(r => r.userId);
const partial = aggregatePnl(memberIds, records, FETCHED);
console.log(`  九人齐、一人缺 → 合计 ${partial.total ?? 'n/a'}  盈利 ${partial.profitable ?? 'n/a'}  ` +
  `覆盖 ${partial.covered}/${partial.expected}  原因: ${partial.reason}`);

// 把第十个人补齐（他的序列换成 30 小时），演示齐全后的结果
const fixed = { ...INPUT[9]!, hours: 30 };
const fixedDerived = deriveRecord(fixed.userId, series(fixed), WINDOW, FETCHED);
if (fixedDerived.ok) records.set(fixed.userId, fixedDerived.record);
const full = aggregatePnl(memberIds, records, FETCHED);
console.log(`  十人齐全       → 合计 ${full.total?.toFixed(2)}  盈利 ${full.profitable} 人  ` +
  `覆盖 ${full.covered}/${full.expected}  窗口 ${iso(full.window!.startTs)} → ${iso(full.window!.endTs)}`);
const manual = [...records.values()].reduce((s, r) => s + r.value, 0);
console.log(`  手工复算合计   → ${manual.toFixed(2)}  ${Math.abs(manual - (full.total ?? NaN)) < 1e-6 ? '✅ 一致' : '❌ 不一致'}`);
console.log(`  手工复算盈利   → ${[...records.values()].filter(r => r.value > 0).length} 人（零收益不算盈利）`);

console.log('\n=== ④ 进入 enrichSocial（同一批成员、同一窗口）===');
const top = INPUT.map((r, i) => ({
  rank: i + 1, userId: r.userId, handle: r.handle,
  evmAddress: `0x${(i + 1).toString(16).padStart(40, '0')}`,
  followers: 1_000 * (i + 1), amount: 1_000_000 - i * 1_000, pnl: 100 * (i + 1), isDev: false,
}));
const balances = new Map(top.map(h => [h.evmAddress, 10n ** 18n]));
const snap = {
  ca: '0x' + 'ab'.repeat(20), total: 491, top: [], balances,
  atBlock: 55_124_734n, atBlockHash: '0xhash', blockTs: NOW - 1_200, takenTs: NOW - 900,
  scannedBlocks: 1, rebuilt: false, latencyMs: 1,
} as any;
const stats = { fomoHolders: 336, top, freshMs: 0, takenTs: NOW - 850, ingestMs: 64 };
const e = enrichSocial(18, snap, stats as any, [], true, new Map(), records, FETCHED);
console.log(`  该币累计收益合计 = ${e.top10TokenPnl}  盈利 ${e.top10TokenProfitable} 人   ← 全时段、该币，另一个量`);
console.log(`  全平台24H 合计   = ${e.top10PlatformPnl24h?.toFixed(2)}  盈利 ${e.top10PlatformProfitable24h} 人`);
console.log(`  覆盖 ${e.top10PlatformCovered}/${e.top10Count}  集合状态 ${e.top10SetStatus}`);

console.log('\n=== ⑤ 渲染结果 ===');
const card: AlertData = {
  ca: snap.ca, symbol: 'MEME', name: 'A Meme Coin', marketCapUsd: 126_120,
  triggerTs: NOW - 301_800, volume5m: 22_360, volume1h: 212_120,
  initial: { total: 178, fomo: 72, offsetMs: 800 },
  recheck: { total: 491, fomo: 336, offsetMs: 301_000 },
  leaderboardHolders: [], leaderboardAvailable: true, leaderboardPartial: true,
  top10: {
    tokenPnlTotal: e.top10TokenPnl, tokenPnlCovered: e.top10TokenPnlCovered, tokenProfitable: e.top10TokenProfitable,
    platformPnl24h: e.top10PlatformPnl24h, platformProfitable: e.top10PlatformProfitable24h,
    platformCovered: e.top10PlatformCovered, platformWindow: e.top10PlatformWindow,
    platformFetchedTs: e.top10PlatformFetchedTs, platformState: 'ready', platformReason: e.top10PlatformReason,
    identified: e.identified, count: e.top10Count, offsetMs: 301_000,
  },
  sources: {
    chainBlock: '55124734', chainBlockTs: snap.blockTs, chainTakenTs: snap.takenTs,
    fomoRespTs: stats.takenTs, boardTakenTs: null, marketTakenTs: NOW - 800,
    sourceSkewMs: stats.takenTs - snap.takenTs, degraded: [],
  },
  health: { sourceOk: true, holderCoverage: [49, 336], ingestMs: 64, notifyMode: 'off' },
};
const text = renderCard(card).replace(/<[^>]+>/g, '');
console.log(text.split('\n').map(l => '  ' + l).join('\n'));

if (process.argv.includes('--write')) {
  const OUT = new URL('../docs/run/evidence/', import.meta.url).pathname;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}pnl-trace.json`, JSON.stringify({
    generatedAt: Date.now(), window: WINDOW, fetchedTs: FETCHED,
    perUser, misses,
    aggregateNineOfTen: partial,
    aggregateComplete: full,
    enriched: {
      top10TokenPnl: e.top10TokenPnl, top10TokenProfitable: e.top10TokenProfitable,
      top10PlatformPnl24h: e.top10PlatformPnl24h, top10PlatformProfitable24h: e.top10PlatformProfitable24h,
      top10PlatformCovered: e.top10PlatformCovered, top10Count: e.top10Count,
      top10SetStatus: e.top10SetStatus, top10PlatformWindow: e.top10PlatformWindow,
    },
    renderedCard: text,
  }, null, 2));
  console.log(`\n已写入 docs/run/evidence/pnl-trace.json`);
}
