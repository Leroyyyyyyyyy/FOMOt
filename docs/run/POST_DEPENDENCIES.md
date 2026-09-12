# post_v1 依赖核验报告（阶段 0）

生成时间：2026-09-12T13:12:44.343Z
生成方式：`npx tsx scripts/post-probe.ts`（只读探针，未写数据库、未改 .env、未发送 Telegram）
链：Robinhood Chain chainId=4663
Node：v24.16.0
探测端点：rpc.mainnet.chain.robinhood.com, rpc-robinhood.blockmachine.io

结论计数：verified 16 · unavailable 1 · unknown 4

## 逐项结论

| 项目 | 结论 | 证据 | 证据时间 |
|---|---|---|---|
| RPC rpc.mainnet.chain.robinhood.com · 最新区块 | ✅ verified | block=61132456 ts=2026-09-12T13:12:36.000Z | 2026-09-12T13:12:37.198Z |
| RPC rpc.mainnet.chain.robinhood.com · 实测出块间隔 | ✅ verified | 101.2ms/块（61112456→61132456 实测；配置常量 100ms） | 2026-09-12T13:12:37.498Z |
| RPC rpc.mainnet.chain.robinhood.com · 历史日志（1 小时前） | ✅ verified | getLogs Initialize 200 块返回 4 条 | 2026-09-12T13:12:37.807Z |
| RPC rpc.mainnet.chain.robinhood.com · 历史日志（7 天前） | ✅ verified | getLogs Initialize 200 块返回 3 条 | 2026-09-12T13:12:38.119Z |
| RPC rpc.mainnet.chain.robinhood.com · Swap 日志密度 | ✅ verified | 2671 条 / 500 块 = 5.34 条/块，耗时 528ms | 2026-09-12T13:12:38.647Z |
| RPC rpc.mainnet.chain.robinhood.com · 历史区块时间戳 | ✅ verified | block=61061274 ts=2026-09-12T11:12:32.000Z hash=0x9c255002fe… | 2026-09-12T13:12:38.931Z |
| RPC rpc-robinhood.blockmachine.io · 最新区块 | ✅ verified | block=61132482 ts=2026-09-12T13:12:38.000Z | 2026-09-12T13:12:39.404Z |
| RPC rpc-robinhood.blockmachine.io · 实测出块间隔 | ✅ verified | 101.1ms/块（61112482→61132482 实测；配置常量 100ms） | 2026-09-12T13:12:39.858Z |
| RPC rpc-robinhood.blockmachine.io · 历史日志（1 小时前） | ✅ verified | getLogs Initialize 200 块返回 6 条 | 2026-09-12T13:12:40.331Z |
| RPC rpc-robinhood.blockmachine.io · 历史日志（7 天前） | ✅ verified | getLogs Initialize 200 块返回 4 条 | 2026-09-12T13:12:40.761Z |
| RPC rpc-robinhood.blockmachine.io · Swap 日志密度 | ✅ verified | 2668 条 / 500 块 = 5.34 条/块，耗时 1195ms | 2026-09-12T13:12:41.956Z |
| RPC rpc-robinhood.blockmachine.io · 历史区块时间戳 | ✅ verified | block=61061266 ts=2026-09-12T11:12:31.000Z hash=0x8b7352f938… | 2026-09-12T13:12:42.378Z |
| 报价 · ETH 现价（Blockscout stats） | ❌ unavailable | SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON | 2026-09-12T13:12:42.423Z |
| 报价 · ETH 现价（Coinbase spot） | ✅ verified | price=2542.505（仅现价，非历史序列） | 2026-09-12T13:12:42.821Z |
| 报价 · ETH 现价（CoinGecko simple） | ✅ verified | price=2540.12（仅现价，非历史序列） | 2026-09-12T13:12:43.184Z |
| 报价 · ETH 现价（综合） | ✅ verified | 2/3 路可用。现有 blockscout.ethPrice() 取中位数并在源间偏离 >10% 时拒绝更新；只剩 1 路时无法交叉校验，post_quotes 需记 quality 降级。 | 2026-09-12T13:12:43.184Z |
| 报价 · ETH 历史逐分钟 USD | ⚠️ unknown | 本次未核验到可直接调用的历史报价接口。按设计文档 §5.3，历史换算只能用本地从启动起积累的 post_quotes；缺口保持 unknown，不得用当前价回算历史。 | 2026-09-12T13:12:43.184Z |
| 报价 · USDG=$1 | ⚠️ unknown | 固定锚定只是 peg_proxy 假设，本次没有独立现价来源验证偏离；卡片与回测必须标注该假设。 | 2026-09-12T13:12:43.184Z |
| Telegram · getMe（只读） | ✅ verified | bot=@FOMOcatch_bot（本次未发送任何消息） | 2026-09-12T13:12:44.342Z |
| DeBot · 开发者接口 | ⚠️ unknown | 设计文档 §9.3：只查到功能教程，没有核验到可复用的 API/WebSocket 契约。首版 debot_enabled=false，走「人工导入 + 纯链上发现」降级路径；未做独立取数 spike 前不得启用 adapter，不从截图猜 URL。 | 2026-09-12T13:12:44.342Z |
| 叙事 · 自动 provider | ⚠️ unknown | 本次没有可用的付费搜索/社媒/模型端点凭据。首版用 manual provider（scripts/post-import.ts）闭环，narrative.provider=manual；自动 provider 属阶段 4，单独验收。 | 2026-09-12T13:12:44.342Z |

## 启动方案判定

- 可用 RPC：rpc.mainnet.chain.robinhood.com, rpc-robinhood.blockmachine.io
- 历史回补（`history.startup_mode=backfill`）：仅当上表「历史日志（7 天前）」为 verified 时才允许开启。
- 本地积累（`history.startup_mode=accumulate`，默认）：任何情况下都可用。二段需要第一波 + 至少 48h 箱体，
  因此启用后的前 2–4 天状态为 `history_warming`，不得声称二段已实盘验收。
- 报价历史：没有已核验的历史 USD 报价接口，ETH 计价的历史换算在本地报价覆盖之外一律 `quoteQuality=missing`，
  对应 K 线 `quality=unknown`；USDG 记 `peg_proxy`。

## 速率与预算（本次观察到的量级，非承诺容量）

- Swap 日志密度见上表；回补并发按 `scan.historical_concurrency=2`，实时扫描独立预算。
- 单次 `eth_getLogs` 命中上限 10000 条由主端点强制，沿用 `AdaptiveRange` 自适应缩放。
- Telegram 发送间隔沿用 3200ms（`notifications.min_gap_ms`）。

## 未核验事项（不得据此宣称已连通）

- DeBot 开发者接口：unknown。
- 自动叙事 provider：unknown。
- 历史 ETH/USD 逐分钟报价源：unknown。
- 其它链（含 BSC）：本报告只覆盖 chainId=4663。
