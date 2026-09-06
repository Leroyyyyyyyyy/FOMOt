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

const platformFn = () => src.slice(src.indexOf('async platformPnl24h'), src.indexOf('isStopped()'));

test('关闭时返回空结果，卡片走 n/a，绝不用该币收益顶替', () => {
  assert.match(platformFn(), /if \(!PLATFORM_PNL_ENABLED[^)]*\) return done\(null, 0\)/,
    '关闭时必须直接返回空结果，让聚合走覆盖率不足 -> n/a 的路径');
});

test('缓存键必须带口径与目标窗口，只按 userId 缓存会跨整点混算', () => {
  const key = src.slice(src.indexOf('private cacheKey'), src.indexOf('private pickCachedAnchor'));
  assert.match(key, /\$\{userId\}\|\$\{w\.basis\}\|\$\{w\.startTs\}-\$\{w\.endTs\}/,
    '缓存键要包含 userId + 口径 + 窗口起止');
  assert.match(platformFn(), /pickCachedAnchor\(ids, preferredEndTs\)/,
    '复用缓存前必须先确认它属于本次聚合可用的锚点窗口');
});

test('推导记录走统一的窗口校验，不在抓取处自己挑「最新点」', () => {
  const fn = platformFn();
  assert.match(fn, /deriveRecord\(id, raw, window, Date\.now\(\)\)/,
    '必须按**给定窗口**推导，起止点由 pnl.ts 严格校验');
  assert.ok(!/rows\[rows\.length - 1\]/.test(fn), '不能再取序列最后一个点当窗口右端');
  assert.match(fn, /anchorWindow\(raw, preferredEndTs\)/, '窗口锚点只在第一次成功取数时定一次');
});

test('等待按 userId 匹配有效响应，不再盲等固定五秒', () => {
  const fn = platformFn();
  assert.ok(!/waitForTimeout\(5_?000\)/.test(fn), '固定五秒盲等必须去掉');
  assert.match(fn, /waiters\.get\(id\)\?\.\(\)/, '响应到达时按 userId 唤醒对应的等待');
  assert.match(fn, /PLATFORM_PNL_WAIT_MS/, '等待要有超时上限');
  assert.match(fn, /waiters\.clear\(\)/, '收尾要清理监听与等待器，避免迟到响应算到下一位用户');
});
