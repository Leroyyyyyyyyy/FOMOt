import type { BrowserContext, Page } from 'playwright';
import { FOMO_ORIGIN, isFomoApi } from './session.js';

export interface AuthProbe {
  loggedIn: boolean;
  apiCalls: number;
  finalUrl: string;
  authKeys: string[];
  reason: string;
}

/**
 * 判断这个浏览器会话到底登没登录。
 *
 * 关键事实（从前端 manifest 的路由表读出来的）：`/` 有两套 layout——
 * 未登录走 `layouts/static`（营销页，**一个 prod-api 调用都没有**），
 * 登录后走 `layouts/authenticated`（feed + 排行榜，才会打 API）。
 * 而且 `/tokens/:chain/:addr` 这类 app 路由未登录时会直接被弹回首页。
 *
 * 所以「有没有捕获到 prod-api 响应」本身就是可靠的登录信号，
 * 只是不能像之前那样把「没捕获到」一律报成「会话过期」——更常见的情况是压根没登录过。
 */
export async function probeAuth(ctx: BrowserContext, page: Page, waitMs = 9000): Promise<AuthProbe> {
  let apiCalls = 0;
  const onResponse = (r: { url(): string; ok(): boolean }) => {
    if (isFomoApi(r.url()) && r.ok()) apiCalls++;
  };
  ctx.on('response', onResponse);
  try {
    await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(waitMs);
  } finally {
    ctx.off('response', onResponse);
  }

  const authKeys = await page.evaluate(() => {
    try {
      return Object.keys(localStorage).filter(k => /privy|auth|token|session/i.test(k));
    } catch { return [] as string[]; }
  }).catch(() => [] as string[]);

  const finalUrl = page.url();
  // 旧 token 留在 localStorage 并不代表会话有效；必须真的拿到成功的鉴权 API 响应。
  const loggedIn = apiCalls > 0;
  return {
    loggedIn, apiCalls, finalUrl, authKeys,
    reason: loggedIn
      ? `已登录（捕获 ${apiCalls} 个 prod-api 响应，凭据键 ${authKeys.length} 个）`
      : apiCalls === 0 && authKeys.length === 0
        ? '未登录：拿到的是未登录的营销页，没有任何 API 调用，localStorage 里也没有凭据'
        : `疑似登录态失效（API 调用 ${apiCalls}，凭据键 ${authKeys.length}）`,
  };
}
