import { chromium, type BrowserContext } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { env } from '../config.js';
import { log } from '../logger.js';

const PROFILE_DIR = new URL('../../data/fomo-session/', import.meta.url).pathname;
export const FOMO_ORIGIN = 'https://fomo.family';

/** 正常 Chrome 的 UA。绝不能让 "HeadlessChrome" 出现在里面。 */
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** 前端每个 prod-api 请求都会带的自定义头，缺了会被拒。4663 就是 Robinhood Chain。 */
export const FOMO_HEADERS = {
  'x-supported-chains': '56,143,4663,8453,1399811149',
  'accept-language': 'en-US',
  'content-type': 'application/json',
} as const;
export const FOMO_API = 'https://prod-api.fomo.family';

/**
 * 前端不止打 prod-api——实测还有 app-actions / app-actions2 两个域名，
 * 而且 prod-api 常被机器人检测拒掉（返回不带 CORS 头的错误，浏览器报成 CORS 失败），
 * app-actions 反而是通的。只听 prod-api 会把能用的数据全漏掉。
 */
export const FOMO_API_HOSTS = [
  'prod-api.fomo.family',
  'app-actions.fomo.family',
  'app-actions2.fomo.family',
];

export function isFomoApi(url: string): boolean {
  try { return FOMO_API_HOSTS.includes(new URL(url).host); } catch { return false; }
}

export function hasSession(): boolean {
  return existsSync(PROFILE_DIR) && existsSync(`${PROFILE_DIR}Default`);
}

/**
 * 用持久化 profile 而不是 storageState：FOMO 走 Privy 登录，
 * 相关凭据散在 localStorage / IndexedDB / cookie 里，持久化 profile 一次性全带上。
 */
export async function openContext(headless = env.fomoHeadless): Promise<BrowserContext> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  /**
   * headless 模式下 Chrome 的 UA 里带 "HeadlessChrome"，prod-api 就是靠这个把请求
   * 拒掉的（返回 430/431 且不带 CORS 头，浏览器那边表现为 CORS 错误，很有迷惑性）。
   * 覆盖成正常 Chrome 的 UA 即可。
   */
  const channel = process.env.FOMO_BROWSER_CHANNEL ?? 'chrome';
  const launch = {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    userAgent: UA,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, { ...launch, channel });
  } catch (err) {
    log.warn({ channel, err: String(err).slice(0, 120) }, '装不上真实 Chrome，退回自带 Chromium（可能被机器人检测拦）');
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, launch);
  }
  ctx.setDefaultTimeout(30_000);
  log.debug({ headless }, '浏览器会话已打开');
  return ctx;
}
