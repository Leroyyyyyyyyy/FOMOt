/**
 * post 配置自检：npm run post:check-config [-- --file config/post-strategy.yaml]
 *
 * 只解析和校验，不连 RPC、不碰数据库、不发消息。校验不过退出码为 1。
 */
import { loadPostConfigFile, POST_CONFIG_PATH, VERSIONED_DEFAULTS } from '../src/post/config.js';

const i = process.argv.indexOf('--file');
const path = i > 0 && process.argv[i + 1]
  ? new URL(`../${process.argv[i + 1]}`, import.meta.url).pathname
  : POST_CONFIG_PATH;

const r = loadPostConfigFile(path);
if (!r.config) {
  console.error(`✗ ${path}\n`);
  for (const e of r.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const c = r.config;
console.log(`✓ ${path}`);
console.log(`  version      ${c.version}`);
console.log(`  configHash   ${r.hash}   ← 信号卡与 episode 都会带这个指纹`);
console.log(`  chains       ${c.chains.join(', ')}`);
console.log(`  启动模式     history.startup_mode=${c.history.startup_mode}（lookback ${c.history.lookback_days} 天）`);
console.log(`  3–5M 口径    size_band.mode=${c.size_band.mode}` +
  (c.size_band.mode === 'volume_usd' ? `（窗口 ${c.size_band.volume_window_hours}h）` : '') +
  (c.size_band.mode === 'fdv_proxy' ? '（FDV 代理，暂定）' : '') +
  (c.size_band.mode === 'off' ? '（量级限制未启用）' : ''));
console.log(`  策略开关     二段=${c.second_leg.enabled} 新币=${c.new_pullback.enabled} 百万=${c.million_reclaim.enabled} RSI=${c.rsi.enabled}`);
console.log(`  叙事         provider=${c.narrative.provider} 硬门=${c.narrative.required_for_standard_signal}`);
console.log(`  外部候选     debot=${c.external_candidates.debot_enabled} 人工导入=${c.external_candidates.manual_import_enabled}`);
console.log('\n未写入 YAML 的版本化常量（随 configHash 一起版本化）:');
for (const [k, v] of Object.entries(VERSIONED_DEFAULTS)) console.log(`  ${k.padEnd(28)} ${v}`);
