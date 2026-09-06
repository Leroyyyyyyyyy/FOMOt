import { rules, validateRules } from '../src/config.js';
const errors = validateRules();
console.log('filters 解析结果:');
for (const [k, v] of Object.entries(rules.filters)) console.log(`  ${k.padEnd(26)} ${JSON.stringify(v)}`);
console.log(errors.length ? `\n❌ 配置无效: ${errors.join('; ')}` : '\n✅ 全部解析正常');
if (errors.length) process.exitCode = 1;
