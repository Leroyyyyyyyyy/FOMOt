import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/fomo/scraper.ts', import.meta.url), 'utf8');

/**
 * 这一组锁住 60 分钟实跑里抓到的缺陷：
 * 共享页被关掉后（`Target page, context or browser has been closed`），
 * refreshLeaderboard 每 5 分钟失败一次、tokenStats 也导航不了，
 * 所有币永远停在「待预热」，触发彻底停摆；而 ready 还是 true，
 * recoverAuth 只在 !ready 时才跑，所以永远不自愈。
 */

test('导航前一定先确保页面可用', () => {
  // 三条会用到共享页的路径都要先 ensurePage
  const refresh = src.slice(src.indexOf('async refreshLeaderboard'), src.indexOf('async leaderboard24h'));
  assert.match(refresh, /ensurePage\(\)/, 'refreshLeaderboard 必须先确保页面可用');

  const tokenStats = src.slice(src.indexOf('async tokenStats('), src.indexOf('isStopped()'));
  assert.match(tokenStats, /ensurePage\(\)/, 'tokenStats 的共享页路径必须先确保页面可用');

  const recover = src.slice(src.indexOf('async recoverAuth'), src.indexOf('拦响应 → 解析'));
  assert.match(recover, /ensurePage\(\)/, 'recoverAuth 必须先确保页面可用');
});

test('ensurePage 会在页面已关闭时重建', () => {
  const fn = src.slice(src.indexOf('private async ensurePage'), src.indexOf('businessStaleMs()'));
  assert.match(fn, /isClosed\(\)/, '要检查页面是否已关闭');
  assert.match(fn, /newPage\(\)/, '关了就要新建');
  assert.match(fn, /openBrowser\(\)/, '连上下文都没了就重开浏览器');
});

test('业务接口久未成功要主动降级，而不是靠 ready 自己变 false', () => {
  const fn = src.slice(src.indexOf('markStaleIfNeeded'), src.indexOf('会话过期或浏览器退出后'));
  assert.match(fn, /this\.ready = false/, '超时必须把 ready 置 false');
  assert.match(fn, /'stale'/, '健康位要能区分出 stale');
});

test('后台恢复循环不能只看 ready', () => {
  const loop = src.slice(src.indexOf('while (!p.isStopped())'), src.length);
  assert.match(loop, /markStaleIfNeeded/,
    '页被关掉时 ready 仍为 true，只看 ready 的话恢复逻辑永远不会跑');
  assert.match(loop, /recoverAuth/);
});

test('降级为纯链上模式后，Engine 不会再把所有币卡在「等 FOMO 预热」', () => {
  const engine = readFileSync(new URL('../src/engine/index.ts', import.meta.url), 'utf8');
  // fomoWarm 的短路条件：fomo 不可用时直接放行，靠的是 !this.fomo.ready
  assert.match(engine, /const fomoWarm = !this\.fomo\.ready \|\| this\.fomo\.tokenStatsWarm/,
    'FOMO 不可用时必须放行，否则数据源一挂就再也不触发');
});

test('全平台 24H 收益默认开启，只能被显式 FOMO_PLATFORM_PNL=0 关掉', () => {
  assert.match(src, /const PLATFORM_PNL_ENABLED = process\.env\.FOMO_PLATFORM_PNL !== '0'/,
    '默认必须是开启（opt-out），不是 opt-in');
});

test('关闭时返回空 Map，卡片走 n/a，绝不用该币收益顶替', () => {
  const fn = src.slice(src.indexOf('async platformPnl24h'), src.indexOf('isStopped()'));
  assert.match(fn, /if \(!PLATFORM_PNL_ENABLED[^)]*\) return out/,
    '关闭时必须直接返回空 Map（out），让 enrich 走覆盖率不足 -> n/a 的路径');
});

test('序列不足 24 小时就不给值，不能拿更短的窗口冒充', () => {
  const fn = src.slice(src.indexOf('async platformPnl24h'), src.indexOf('isStopped()'));
  assert.match(fn, /if \(!prev\) continue/, '找不到 24h 前的点就跳过这个人');
  assert.match(fn, /window: 'snapshot'/, '窗口口径要标成 snapshot，不能和榜单的 live 混着求和');
});
