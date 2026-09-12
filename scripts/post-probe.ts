/**
 * 阶段 0 只读依赖探针（设计文档 §13 阶段 0）。
 *
 * 目的：在写任何策略代码之前，把「文档里列了接口」和「接口真的能用」分开。
 * 这个脚本**只读**：不写库、不改 .env、不发 Telegram、不点任何推广链接。
 * 输出脱敏报告（不打印 token / chat_id / 完整 RPC 查询串）。
 *
 *   npx tsx scripts/post-probe.ts [--hours 2]
 *
 * 每项结论只有三种：verified（本次实测通过）/ unavailable（本次实测失败）/
 * unknown（没有可验证入口，不能替它下结论）。
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { env, chain } from '../src/config.js';
import { poolManagerAbi } from '../src/chain/abi.js';
import { robinhoodChain } from '../src/chain/client.js';

type Status = 'verified' | 'unavailable' | 'unknown';
interface Finding {
  item: string;
  status: Status;
  detail: string;
  evidenceAt: string;
}

const findings: Finding[] = [];
const add = (item: string, status: Status, detail: string) =>
  findings.push({ item, status, detail, evidenceAt: new Date().toISOString() });

const hoursArg = process.argv.indexOf('--hours');
const lookbackHours = hoursArg > 0 ? Number(process.argv[hoursArg + 1]) : 2;

/** 每个端点单独建 client：fallback 会掩盖「某个端点不行」这个结论。 */
function single(url: string) {
  return createPublicClient({ chain: robinhoodChain, transport: http(url, { batch: false, retryCount: 0, timeout: 15_000 }) });
}
const host = (u: string) => { try { return new URL(u).host; } catch { return '(无效 URL)'; } };

async function probeRpc(url: string): Promise<{ latest: bigint; blockTimeMs: number } | null> {
  const c = single(url);
  const label = host(url);
  let latest: bigint;
  try {
    const b = await c.getBlock({ blockTag: 'latest' });
    latest = b.number;
    add(`RPC ${label} · 最新区块`, 'verified', `block=${latest} ts=${new Date(Number(b.timestamp) * 1000).toISOString()}`);
  } catch (err) {
    add(`RPC ${label} · 最新区块`, 'unavailable', String(err).slice(0, 160));
    return null;
  }

  // 真实出块间隔：不能拿配置里的 100ms 外推几天当事实（设计文档 §5.1）。
  let blockTimeMs = 0;
  try {
    const span = 20_000n;
    const older = latest > span ? latest - span : 0n;
    const [a, b] = await Promise.all([c.getBlock({ blockNumber: older }), c.getBlock({ blockNumber: latest })]);
    blockTimeMs = (Number(b.timestamp) - Number(a.timestamp)) * 1000 / Number(latest - older);
    add(`RPC ${label} · 实测出块间隔`, 'verified',
      `${blockTimeMs.toFixed(1)}ms/块（${older}→${latest} 实测；配置常量 ${chain.blockTimeMs}ms）`);
  } catch (err) {
    add(`RPC ${label} · 实测出块间隔`, 'unavailable', String(err).slice(0, 160));
  }

  // 历史日志能力：post 模式的二段需要连续历史，必须确认这个端点不是只服务最近几十块。
  const perHour = blockTimeMs > 0 ? BigInt(Math.round(3600_000 / blockTimeMs)) : 36_000n;
  for (const [name, backHours] of [['1 小时前', 1], ['7 天前', 24 * 7]] as const) {
    const from = latest > perHour * BigInt(backHours) ? latest - perHour * BigInt(backHours) : 0n;
    try {
      const logs = await c.getLogs({ address: chain.poolManager, event: poolManagerAbi[0], fromBlock: from, toBlock: from + 200n });
      add(`RPC ${label} · 历史日志（${name}）`, 'verified', `getLogs Initialize 200 块返回 ${logs.length} 条`);
    } catch (err) {
      add(`RPC ${label} · 历史日志（${name}）`, 'unavailable', String(err).slice(0, 160));
    }
  }

  // Swap 密度：决定回补预算，也决定 AdaptiveRange 初值是否还合理。
  try {
    const from = latest > 500n ? latest - 500n : 0n;
    const t0 = Date.now();
    const logs = await c.getLogs({ address: chain.poolManager, event: poolManagerAbi[1], fromBlock: from, toBlock: latest });
    add(`RPC ${label} · Swap 日志密度`, 'verified',
      `${logs.length} 条 / ${Number(latest - from)} 块 = ${(logs.length / Number(latest - from)).toFixed(2)} 条/块，耗时 ${Date.now() - t0}ms`);
  } catch (err) {
    add(`RPC ${label} · Swap 日志密度`, 'unavailable', String(err).slice(0, 160));
  }

  // 历史区块时间戳可读 = K 线能按真实区块时间分桶，而不是线性外推。
  try {
    const back = latest > perHour * BigInt(lookbackHours) ? latest - perHour * BigInt(lookbackHours) : 0n;
    const b = await c.getBlock({ blockNumber: back });
    add(`RPC ${label} · 历史区块时间戳`, 'verified',
      `block=${back} ts=${new Date(Number(b.timestamp) * 1000).toISOString()} hash=${(b.hash ?? '').slice(0, 12)}…`);
  } catch (err) {
    add(`RPC ${label} · 历史区块时间戳`, 'unavailable', String(err).slice(0, 160));
  }
  return { latest, blockTimeMs };
}

async function probeQuotes(): Promise<void> {
  // ETH 现价：本地从启动开始每分钟留一条报价的前提，是这些来源真的能取到。
  // 逐个探，不能用 blockscout.ethPrice() 的中位数掩盖「某一路已经挂了」。
  const sources: [string, string, (j: any) => number][] = [
    ['Blockscout stats', `${env.blockscoutUrl}/api/v2/stats`, j => Number(j?.coin_price)],
    ['Coinbase spot', 'https://api.coinbase.com/v2/prices/ETH-USD/spot', j => Number(j?.data?.amount)],
    ['CoinGecko simple', 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', j => Number(j?.ethereum?.usd)],
  ];
  let ok = 0;
  for (const [name, url, pick] of sources) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 FOMOt-probe' },
        signal: AbortSignal.timeout(12_000),
      });
      const text = await res.text();
      const price = pick(JSON.parse(text));
      if (price > 0) { ok++; add(`报价 · ETH 现价（${name}）`, 'verified', `price=${price}（仅现价，非历史序列）`); }
      else add(`报价 · ETH 现价（${name}）`, 'unavailable', `HTTP ${res.status}，响应无可用价格字段`);
    } catch (err) {
      add(`报价 · ETH 现价（${name}）`, 'unavailable', String(err).slice(0, 140));
    }
  }
  add('报价 · ETH 现价（综合）', ok >= 2 ? 'verified' : ok === 1 ? 'unknown' : 'unavailable',
    `${ok}/${sources.length} 路可用。现有 blockscout.ethPrice() 取中位数并在源间偏离 >10% 时拒绝更新；` +
    '只剩 1 路时无法交叉校验，post_quotes 需记 quality 降级。');
  add('报价 · ETH 历史逐分钟 USD', 'unknown',
    '本次未核验到可直接调用的历史报价接口。按设计文档 §5.3，历史换算只能用本地从启动起积累的 post_quotes；' +
    '缺口保持 unknown，不得用当前价回算历史。');
  add('报价 · USDG=$1', 'unknown',
    '固定锚定只是 peg_proxy 假设，本次没有独立现价来源验证偏离；卡片与回测必须标注该假设。');
}

async function probeTelegram(): Promise<void> {
  // 只读 getMe，不发任何消息。缺凭据时不算失败，只是「未配置」。
  if (!env.telegramEnabled) {
    add('Telegram · 凭据', 'unknown', '未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，post 模式只能跑 NOTIFY_MODE=off');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.telegramToken}/getMe`, { signal: AbortSignal.timeout(12_000) });
    const j = (await res.json()) as any;
    if (j?.ok) add('Telegram · getMe（只读）', 'verified', `bot=@${j.result?.username ?? '?'}（本次未发送任何消息）`);
    else add('Telegram · getMe（只读）', 'unavailable', String(j?.description ?? `HTTP ${res.status}`).slice(0, 160));
  } catch (err) {
    add('Telegram · getMe（只读）', 'unavailable', String(err).slice(0, 160));
  }
}

function probeExternal(): void {
  add('DeBot · 开发者接口', 'unknown',
    '设计文档 §9.3：只查到功能教程，没有核验到可复用的 API/WebSocket 契约。首版 debot_enabled=false，' +
    '走「人工导入 + 纯链上发现」降级路径；未做独立取数 spike 前不得启用 adapter，不从截图猜 URL。');
  add('叙事 · 自动 provider', 'unknown',
    '本次没有可用的付费搜索/社媒/模型端点凭据。首版用 manual provider（scripts/post-import.ts）闭环，' +
    'narrative.provider=manual；自动 provider 属阶段 4，单独验收。');
}

function render(rpcInfo: Map<string, { latest: bigint; blockTimeMs: number } | null>): string {
  const icon = (s: Status) => (s === 'verified' ? '✅ verified' : s === 'unavailable' ? '❌ unavailable' : '⚠️ unknown');
  const rows = findings.map(f => `| ${f.item} | ${icon(f.status)} | ${f.detail.replace(/\|/g, '\\|')} | ${f.evidenceAt} |`).join('\n');
  const usable = [...rpcInfo.entries()].filter(([, v]) => v).map(([u]) => host(u));
  const n = (s: Status) => findings.filter(f => f.status === s).length;
  return `# post_v1 依赖核验报告（阶段 0）

生成时间：${new Date().toISOString()}
生成方式：\`npx tsx scripts/post-probe.ts\`（只读探针，未写数据库、未改 .env、未发送 Telegram）
链：${chain.name} chainId=${chain.id}
Node：${process.version}
探测端点：${[...rpcInfo.keys()].map(host).join(', ') || '（无）'}

结论计数：verified ${n('verified')} · unavailable ${n('unavailable')} · unknown ${n('unknown')}

## 逐项结论

| 项目 | 结论 | 证据 | 证据时间 |
|---|---|---|---|
${rows}

## 启动方案判定

- 可用 RPC：${usable.length ? usable.join(', ') : '无'}
- 历史回补（\`history.startup_mode=backfill\`）：仅当上表「历史日志（7 天前）」为 verified 时才允许开启。
- 本地积累（\`history.startup_mode=accumulate\`，默认）：任何情况下都可用。二段需要第一波 + 至少 48h 箱体，
  因此启用后的前 2–4 天状态为 \`history_warming\`，不得声称二段已实盘验收。
- 报价历史：没有已核验的历史 USD 报价接口，ETH 计价的历史换算在本地报价覆盖之外一律 \`quoteQuality=missing\`，
  对应 K 线 \`quality=unknown\`；USDG 记 \`peg_proxy\`。

## 速率与预算（本次观察到的量级，非承诺容量）

- Swap 日志密度见上表；回补并发按 \`scan.historical_concurrency=2\`，实时扫描独立预算。
- 单次 \`eth_getLogs\` 命中上限 10000 条由主端点强制，沿用 \`AdaptiveRange\` 自适应缩放。
- Telegram 发送间隔沿用 3200ms（\`notifications.min_gap_ms\`）。

## 未核验事项（不得据此宣称已连通）

- DeBot 开发者接口：unknown。
- 自动叙事 provider：unknown。
- 历史 ETH/USD 逐分钟报价源：unknown。
- 其它链（含 BSC）：本报告只覆盖 chainId=${chain.id}。
`;
}

async function main(): Promise<void> {
  const rpcInfo = new Map<string, { latest: bigint; blockTimeMs: number } | null>();
  for (const url of env.rpcUrls) rpcInfo.set(url, await probeRpc(url));
  await probeQuotes();
  await probeTelegram();
  probeExternal();

  const out = render(rpcInfo);
  const path = new URL('../docs/run/POST_DEPENDENCIES.md', import.meta.url).pathname;
  writeFileSync(path, out);
  console.log(out);
  console.error(`\n报告已写入 ${path}`);
}

main().catch(err => { console.error('探针失败:', err); process.exit(1); });
