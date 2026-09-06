/**
 * 一次性手动登录。
 *
 * 重要：这里开的是一个**独立的浏览器和独立的 profile**，
 * 你日常那个 Chrome 里的登录状态不会带过来——必须在这个新窗口里重新登录一次。
 *
 * 账号、密码、验证码全部由你自己在浏览器里输入，脚本不读取、不保存任何凭据，
 * 只是把登录后产生的会话留在 data/fomo-session/ 里供后续 headless 复用。
 */
import { openContext, FOMO_ORIGIN } from './session.js';
import { probeAuth } from './auth.js';

const ctx = await openContext(false);          // 有头
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});

console.log(`
┌──────────────────────────────────────────────────────────────────┐
│  已打开一个独立的浏览器窗口（不是你平时那个 Chrome）              │
│                                                                  │
│  ⚠️  你 Chrome 里的 FOMO 登录状态不会带到这里，必须在这个新窗口   │
│      里重新登录一次。登录一次之后会一直有效，不用每次都来。       │
│                                                                  │
│  1. 在新窗口里用你自己的账号登录 fomo.family                      │
│  2. 登录到能看见 feed / 排行榜（不是那个落地宣传页）              │
│  3. 回到这个终端按 回车 —— 我会实际验证一遍，不会瞎报成功         │
└──────────────────────────────────────────────────────────────────┘
`);

await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));

console.log('\n验证登录状态中…（约 10 秒）');
const probe = await probeAuth(ctx, page);

if (probe.loggedIn) {
  console.log(`\n✅ ${probe.reason}`);
  console.log('   会话已存到 data/fomo-session/，现在可以 npm start 了。');
} else {
  console.log(`\n❌ ${probe.reason}`);
  console.log(`   当前地址: ${probe.finalUrl}`);
  console.log('   浏览器窗口先别关，登录完再跑一次 npm run login。');
}
await ctx.close();
process.exit(probe.loggedIn ? 0 : 1);
