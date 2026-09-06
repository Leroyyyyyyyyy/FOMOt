/** 快速体检：当前保存的 FOMO 会话还能用吗。 */
import { openContext, hasSession } from '../src/fomo/session.js';
import { probeAuth } from '../src/fomo/auth.js';

if (!hasSession()) {
  console.log('❌ 还没有会话目录，先跑 `npm run login`');
  process.exit(1);
}
const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());
const p = await probeAuth(ctx, page);
console.log(`${p.loggedIn ? '✅' : '❌'} ${p.reason}`);
console.log(`   地址      : ${p.finalUrl}`);
console.log(`   API 调用  : ${p.apiCalls}`);
console.log(`   凭据键    : ${p.authKeys.length ? p.authKeys.join(', ') : '(无)'}`);
await ctx.close();
process.exit(p.loggedIn ? 0 : 1);
