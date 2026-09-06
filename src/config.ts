import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface Range { min?: number; max?: number }
export interface Rules {
  scan: { interval_ms: number; snapshot_delay_ms: number; recheck_delay_ms: number };
  universe: { max_age_minutes: number; min_age_seconds: number };
  filters: {
    market_cap_usd: Range;
    volume_5m_usd: Range;
    volume_1h_usd: Range;
    holders_total: Range;
    fomo_holders: Range;
    fomo_holder_ratio: Range;
    fomo_leaderboard_holders: Range;
    skip_when_unavailable: boolean;
    fomo_gate_stage: 'initial' | 'recheck' | 'off';
  };
  dedup: { cooldown_minutes: number };
  render: { timezone: string; locale: string };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}，请照着 .env.example 填 .env`);
  return v;
}

/**
 * RPC 端点，按优先级排列。主节点优先，出错才降级到备用。
 *
 * 候选是逐个实测筛出来的（见 scripts/probe-rpcs.ts）——注册表上列的那些大多不能用：
 * arrowrpc / ordofi / nodeflare 返回 HTML 而不是 JSON-RPC；
 * publicnode 和 pocket.network 只服务最近约 20 个区块，再往前一律当「归档请求」拒掉，
 * 而我们动辄要扫几百到几万块。
 *
 * blockmachine 实测与主节点逐条一致（同范围 Initialize 34 条、Swap 4327 条），
 * 历史交易可读，而且没有主节点那个「单次命中日志 ≤10000 条」的限制。
 */
const DEFAULT_RPCS = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://rpc-robinhood.blockmachine.io',
];

function rpcList(): string[] {
  const raw = process.env.RPC_URLS ?? process.env.RPC_URL;
  const urls = raw ? raw.split(',').map(u => u.trim()).filter(Boolean) : DEFAULT_RPCS;
  return [...new Set(urls)];
}

export const env = {
  rpcUrls: rpcList(),
  get rpcUrl() { return this.rpcUrls[0] ?? DEFAULT_RPCS[0]!; },
  blockscoutUrl: process.env.BLOCKSCOUT_URL ?? 'https://robinhoodchain.blockscout.com',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  fomoHeadless: process.env.FOMO_HEADLESS !== 'false',
  get telegramEnabled() { return Boolean(this.telegramToken && this.telegramChatId) },
  requireTelegram() { return { token: required('TELEGRAM_BOT_TOKEN'), chatId: required('TELEGRAM_CHAT_ID') } },
};

// chainId 4663 / 出块 ~100ms —— 均已对着主网实测确认
export const chain = {
  id: 4663,
  name: 'Robinhood Chain',
  blockTimeMs: 100,
  explorer: 'https://robinhoodchain.blockscout.com',
  // Uniswap V4 PoolManager。5 个事件签名的 topic0 已与主网日志逐一比对通过。
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const,
  nativeSymbol: 'ETH',
} as const;

// RULES_FILE 可以指向另一份规则文件（跑联调时用 rules.test.yaml 把阈值和延迟都调小）
const rulesPath = process.env.RULES_FILE
  ? new URL(`../${process.env.RULES_FILE}`, import.meta.url)
  : new URL('../config/rules.yaml', import.meta.url);
export const rules: Rules = parse(readFileSync(rulesPath, 'utf8'));

/**
 * 启动时校验规则文件。YAML 很容易写错——比如 `key:{ min: 0 }` 少个空格就不会被
 * 解析成映射，那条规则悄悄变成 undefined。宁可启动时吵一句，也别等触发时才炸。
 */
const EXPECTED_FILTERS = [
  'market_cap_usd', 'volume_5m_usd', 'volume_1h_usd', 'holders_total',
  'fomo_holders', 'fomo_holder_ratio', 'fomo_leaderboard_holders',
] as const;

export function validateRules(): string[] {
  const errors: string[] = [];
  const root = rules as unknown as Record<string, any>;
  const filters = root.filters;
  if (!filters || typeof filters !== 'object') return ['filters 必须是对象'];
  for (const k of EXPECTED_FILTERS) {
    const r = filters[k];
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`${k} 必须是区间对象`); continue; }
    for (const edge of ['min', 'max'] as const) {
      if (r[edge] !== undefined && (typeof r[edge] !== 'number' || !Number.isFinite(r[edge]))) {
        errors.push(`${k}.${edge} 必须是有限数字`);
      }
    }
    if (typeof r.min === 'number' && typeof r.max === 'number' && r.min > r.max) errors.push(`${k} 的 min 不能大于 max`);
  }
  if (typeof filters.skip_when_unavailable !== 'boolean') errors.push('skip_when_unavailable 必须是布尔值');
  if (!['initial', 'recheck', 'off'].includes(filters.fomo_gate_stage)) errors.push('fomo_gate_stage 必须是 initial/recheck/off');
  for (const [path, value, min] of [
    ['scan.interval_ms', root.scan?.interval_ms, 50],
    ['scan.snapshot_delay_ms', root.scan?.snapshot_delay_ms, 0],
    ['scan.recheck_delay_ms', root.scan?.recheck_delay_ms, 0],
    ['universe.max_age_minutes', root.universe?.max_age_minutes, 1],
    ['universe.min_age_seconds', root.universe?.min_age_seconds, 0],
    ['dedup.cooldown_minutes', root.dedup?.cooldown_minutes, 0],
  ] as [string, unknown, number][]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) errors.push(`${path} 必须是 >= ${min} 的有限数字`);
  }
  try { new Intl.DateTimeFormat('en', { timeZone: root.render?.timezone }).format(); }
  catch { errors.push('render.timezone 不是有效时区'); }
  if (typeof root.render?.locale !== 'string' || !root.render.locale) errors.push('render.locale 必须是非空字符串');
  if (typeof filters.fomo_holder_ratio?.min === 'number' && filters.fomo_holder_ratio.min < 0) errors.push('fomo_holder_ratio.min 不能小于 0');
  if (typeof filters.fomo_holder_ratio?.max === 'number' && filters.fomo_holder_ratio.max > 1) errors.push('fomo_holder_ratio.max 不能大于 1');
  if (typeof root.scan?.snapshot_delay_ms === 'number' && typeof root.scan?.recheck_delay_ms === 'number'
      && root.scan.snapshot_delay_ms >= root.scan.recheck_delay_ms) errors.push('snapshot_delay_ms 必须小于 recheck_delay_ms');
  return errors;
}

export const links = {
  fomo: (ca: string) => `https://fomo.family/tokens/robinhood/${ca}`,
  gmgn: (ca: string) => `https://gmgn.ai/robinhood/token/${ca}`,
  scout: (ca: string) => `${chain.explorer}/token/${ca}`,
};
