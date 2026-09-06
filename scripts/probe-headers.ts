import { openContext, FOMO_ORIGIN } from '../src/fomo/session.js';

const ctx = await openContext(true);
const page = ctx.pages()[0] ?? (await ctx.newPage());

const seen: { url: string; headers: Record<string, string> }[] = [];
page.on('request', req => {
  if (req.url().includes('prod-api.fomo.family')) seen.push({ url: req.url(), headers: req.headers() });
});

await page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(12000);

const SENSITIVE = /^(authorization|cookie|x-.*-token|.*-key|.*-secret)$/i;
console.log(`捕获 ${seen.length} 个 prod-api 请求\n`);
for (const s of seen.slice(0, 4)) {
  console.log(new URL(s.url).pathname);
  for (const [k, v] of Object.entries(s.headers).sort()) {
    if (k.startsWith(':')) continue;
    // 敏感值只显示前缀和长度，不外泄凭据本身
    const shown = SENSITIVE.test(k) ? `<${v.split(' ')[0]}… 共 ${v.length} 字符>` : v.slice(0, 90);
    console.log(`   ${k.padEnd(26)} ${shown}`);
  }
  console.log();
}
await ctx.close();
process.exit(0);
