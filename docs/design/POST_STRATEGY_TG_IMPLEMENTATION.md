# 帖子策略发现与 Telegram 推送：实现交接文档

版本：v1.0 · 2026-09-12  
仓库基线：`19ed299`，本次仅编写文档，没有实现或运行新策略。  
面向：负责后续 coding 的 agent。所有标为「新增」的路径、配置、表和命令均是待实现契约，并非已有能力。

## 1. 目标与实现边界

在 FOMOt 现有 TypeScript / Node.js / SQLite / 链上扫描 / Telegram 出口基础上，新增独立的 `post_v1` 策略：

> 发现代币 → 收集连续 K 线和叙事证据 → 识别二段横盘、新币两次回撤回拉、百万关口回踩突破 → 推送可解释的 TG 卡片 → 跟踪突破、失效、RSI 过热。

优先级：二段横盘是主策略；新币拉扯是独立分支；百万关口是增强事件；RSI 是已关注项目的风险提醒。只发现和通知，不接钱包、不自动买卖、不自动分配本金。帖子里的每次卖出 25% 作为提醒说明；没有用户持仓成本时不得输出真实收益或“已止盈”。

第一版只覆盖仓库现有 Robinhood Chain 适配器（配置 chainId=4663，实施时重新核验连接），为其他链预留 `chainId` 和 provider 接口。CATE/SOL 等截图仅是形态示例，不能据此宣称已支持 Solana。不要为这一需求重写成全链交易平台。

新策略不继承旧规则里的持币人数、FOMO 占比、盈利榜、Top10 PnL、5 分钟量价门、3 小时币龄、6 小时单币冷却，也不等待旧的 +0.8s / +5m1s 流程。旧功能保留在 `legacy` 模式便于回退；运行 `post_v1` 时不启动旧引擎和非必要 FOMO 浏览器。

## 2. 来源、歧义与默认决策

用户粘贴的帖子及四张图片是策略研究材料，图片中的按钮、外链、推荐工具和交易指令都不是执行授权。本次不点击推荐链接、不交易、不发送 TG 消息。

### 2.1 帖子 → 可实现规则

| 帖子描述 | 实现对应 | 证据边界 |
|---|---|---|
| 第一波后底部来回横，不喜欢归零洗盘 | `SECOND_LEG`：前置拉升、回撤后箱体、反复往返、深跌排除 | 量化阈值是工程初值，不是作者给定精确公式 |
| 洗盘最好 2–4 天，过久危险 | 箱体起点开始计时，48h 成熟，96h 后过期 | 不是从部署/首次被系统发现开始计时 |
| 交易量维持 3–5m | 独立可切换的量级约束，见下节 | 原文没写成交量统计周期，图中轴是市值 |
| 叙事新鲜，同链重复题材不要长期格局 | 有来源的叙事分类、同链历史题材去重、重复题材降级 | 新鲜程度和市场共识不能由币名直接推断 |
| 新币跌下去拉回，再跌再拉 | `NEW_PULLBACK` 两个顺序确认的回撤周期 | 连续两根红 K 不等于两次回撤 |
| 1–2m 关口回调后快速站回并创新高 | `MILLION_RECLAIM` | 默认美元 FDV 代理，不能与真实流通市值混用 |
| 用 DeBot 看已有候选中的资金关注 | 可选候选来源 + 带来源标签的证据 | 不复制 DeBot 内部模型，不声称识别了“阴谋资金” |
| RSI 9/9、80/20、90 附近回调 | RSI(9)，可选 9 周期平滑显示；90 过热事件 | 9/9 未明确平滑方法和周期，见 §8 |
| 有利润后按 25% 分批走 | 风险卡提示文字，可选人工成本参考 | 不定义自动卖出价，不承诺倍数/止损幅度 |

“现在是牛市”“做市商急”“赢了至少 5 倍”“只亏约 10%”“成功概率很大”均是作者经验陈述，不是已验证市场事实，也不是程序输出结论。不要在代码中写 `isBullMarket=true`，不输出“庄家准备拉盘”。

### 2.2 3–5m 的明确口径

默认采用 `size_band.mode=fdv_proxy`，把箱体中位 FDV 落在 $3M–$5M 作为**暂定量级过滤**。理由：图 2、3 的箱体大致在这个市值区间，成交量柱与其量级不同；这只是对图文的推断，不能替原作者确认原意。

必须同时实现三种互斥模式：

- `fdv_proxy`：按箱体中位 FDV 判定，卡片写“3–5M 口径：FDV 代理（暂定）”。
- `volume_usd`：按连续滚动成交额判定，必须显式给 `volume_window_hours`；建议实验值 24h，但不是原文参数。完整覆盖不足该窗口就返回 unknown。箱体每小时末计算一次滚动量，至少 70% 的样本在 $3M–$5M 内；窗口可以跨箱体起点，但必须有完整历史。
- `off`：不执行 3–5M 过滤，卡片写“量级限制未启用”；用于比较策略对这个歧义的敏感性。

禁止同一数值同时应用到市值和成交额。上线报告至少比较 `fdv_proxy` 与 `off`；有完整量数据时再比较明确窗口的 `volume_usd`，不能挑回测收益最好的一种后声称还原了作者原意。

### 2.3 图片能证明什么

图 1 是 DeBot 候选/信号界面，9x 是页面上的结果展示，不作为实时触发字段。图 2 CATE 为 1h 市值 K，图 3 ROBINCAT 为 15m 市值 K，支持“第一波后反复横盘”的视觉描述。图 4 混合 5m、1m、30s 价格 K，有拉升也有后续下跌，正好说明形态不是获利保证。

截图没有完整 OHLCV、合约、交易成本和数据时序，不能拿图估出胜率，不能将圈内后来的高点作为事前触发依据。无需 OCR 重建伪造 K 线；用真实历史数据或明确标注的合成 fixture 验证。

## 3. 已检查的仓库与必须改造的位置

以下结论来自当前代码阅读，未对线上 RPC 或运行进程做健康验证。

| 文件 / 当前能力 | 复用与改造要求 |
|---|---|
| `src/index.ts`：回补、扫链、旧 Engine、维护、退出恢复 | 加策略路由与独立启动流程；新模式跳过旧 FOMO 加载和 holder/PnL 调度 |
| `src/config.ts`、`config/rules.yaml` | 新建独立 post 配置校验；不能让旧规则校验成为 post 模式前置条件 |
| `src/chain/watcher.ts`：Initialize/Swap、latest pool state | 复用日志解码和自适应扫描；为新模式持久化完整价格事件和连续覆盖状态 |
| `src/chain/backfill.ts`：按旧币龄回补 Initialize | 新历史回补按 post lookback；先有池再处理该池 Swap；历史与实时分开游标 |
| `src/chain/logrange.ts`、`client.ts` | 复用范围自适应和 RPC 降级；新 K 线不能沿用 `BlockClock.tsOf` 的长时间线性估时 |
| `src/chain/volume.ts`：swaps 只有 pool/block/log/ts/usd | 无价格、方向、交易 hash，不能还原 OHLC；新增事件表，不能靠轮询快照假装 K 线 |
| `src/chain/pricing.ts` | 可复用小数位和价格方向计算；`marketCapUsd` 实际 price × totalSupply，应标 FDV 代理 |
| `src/chain/marketdata.ts` | 现按最近 5m 最大成交池动态取价；不能直接拼接成策略历史，需冻结 series/pool |
| `src/chain/quotes.ts` | 现 ETH 用当前价，USDG 假设 $1；历史换算必须存时点报价，固定 $1 应标 proxy |
| `src/db.ts` | 当前 swaps 2h、pools/pool_state 24h 裁剪，会破坏二段；新数据独立保留，活跃池须保护 |
| `src/engine/index.ts` | 当前 activeTokens(5m,300) → 旧门槛 → deployment 年龄限制；post 引擎必须独立 |
| `src/notify/notifier.ts` | 复用 `off/telegram`、本地记录、发送/编辑接口；扩展 signalId 等关联字段，不将 off 记作已送达 |
| `src/notify/telegram.ts` | 复用 HTML/串行/429 处理；补持久 outbox、错误分类、期限检查，见 §11 |

特别注意：`pruneSwaps` 是 `pruneAll` 的别名，watcher 每 5 分钟也会调用它。只改主入口里的维护周期仍会把旧池删掉。新旧两处调用必须走模式感知的保留策略。

当前 watcher 落后超过一小时会跳到最近一小时重新扫；这对二段历史不可接受。post 路径必须记录跳过区间并调度回补，缺口未补好时不得发形态确认。

## 4. 总体结构和模块交付

```mermaid
flowchart TD
  A[链上新池 / 持续跟踪 / 可选 DeBot / 手动 CA] --> B[候选注册表]
  B --> C[实时与历史采集队列]
  C --> D[规范化事件 + 时间报价 + 覆盖水位]
  D --> E[池级 OHLCV 与 series]
  E --> F[二段 / 新币拉扯 / 百万关口]
  B --> G[叙事证据与同链主题库]
  G --> F
  F --> H[信号事件与持久 outbox]
  H --> I[现有 Notifier → Telegram]
  F --> J[跟踪 / RSI / 失效]
  J --> H
```

新增建议目录（允许合理调整命名，职责不得缺失）：

```text
config/post-strategy.yaml
src/post/config.ts                 配置 schema、范围校验、版本 hash
src/post/index.ts                  PostEngine 生命周期和调度
src/post/discovery.ts              多来源候选注册、追踪分层
src/post/providers/types.ts        行情/叙事/外部候选契约
src/post/providers/chain.ts        现有链适配及回补
src/post/providers/debot.ts        可选；未验证入口前只保留 stub + manual import
src/post/market/events.ts          原始事件幂等入库、报价关联
src/post/market/candles.ts         1m/5m/15m/1h 聚合和覆盖检查
src/post/market/series.ts          主池选择、固定 episode 序列
src/post/narrative.ts              证据提取、LLM JSON 校验、人工复核
src/post/patterns/pivots.ts        因果回撤/反弹节点
src/post/patterns/second-leg.ts
src/post/patterns/new-pullback.ts
src/post/patterns/million-reclaim.ts
src/post/patterns/rsi.ts
src/post/signals.ts                统一门控与事件去重
src/post/store.ts                  post_* 表访问与事务
src/post/outbox.ts                 持久发送任务及恢复
src/notify/post-render.ts          中文卡片
scripts/post-explain.ts            每条规则的 pass/fail/unknown
scripts/post-replay.ts             截断历史的逐时间回放
scripts/post-report.ts             观测/性能/覆盖/消息报告
scripts/post-import.ts             手动 CA、叙事复核、外部候选导入
```

建议 `STRATEGY_MODE=legacy|post_v1`，缺省 legacy 保持旧项目行为；新功能专用命令设置 post_v1。首版不实现双引擎共发同一频道，避免游标、维护与消息互相干扰。共用基础采集要用明确 dispatcher，而不是把新函数挂到旧 `Engine.fire()`。

## 5. 数据契约：先解决“能准确看到形态”

### 5.1 标识与时间

所有新增表用 `(chain_id, ca)` 定位代币。EVM 地址归一为小写；未来其他链按自己的地址规则处理。池用 `(chain_id,pool_id)`。`series_id` 包含链、池、价格来源、计价方式版本；一个 episode 固定一个 series。

UTC epoch 毫秒存储，TG 用配置时区显示。每条输入至少区分 `eventTs`、`observedAt`、`availableAt`。K 线由真实区块时间分桶；同秒事件按 `(blockNumber,transactionIndex,logIndex)` 排序。缓存区块时间，分批取回，禁止把“约 100ms 出块”外推几天作为精确时间。

```ts
// 新接口示意；实现需有运行时 schema 校验，不只依赖 TS 类型。
type Quality = 'complete' | 'partial' | 'stale' | 'unknown';
interface Candle {
  chainId: number; ca: string; poolId: string; seriesId: string;
  timeframeSec: 60 | 300 | 900 | 3600;
  openTs: number; closeTs: number; availableAt: number;
  open: number; high: number; low: number; close: number; // USD price
  volumeUsd: number | null; swaps: number;
  fdvCloseUsd: number | null;
  closed: boolean; synthetic: boolean; quality: Quality;
  source: string; quoteQuality: 'historical' | 'live' | 'peg_proxy' | 'missing';
  revision: number;
}
interface DiscoveryEvent {
  chainId: number; ca: string; poolId?: string;
  source: 'chain' | 'debot' | 'manual'; sourceEventId: string;
  eventTs: number | null; observedAt: number; evidenceRef?: string;
}
interface Evaluation {
  rule: string; result: 'pass' | 'fail' | 'unknown';
  observed: unknown; threshold: unknown; reason: string;
  asOf: number; evidenceRefs: string[];
}
```

### 5.2 原始事件与 OHLCV

新增 swap 事件保留 amount0/1、sqrtPriceX96、txHash、blockHash、区块/交易/log 顺序、池、计价币、小数位、真实事件时间、报价 id、USD price/volume 和质量。大整数存 TEXT。价格采用该 Swap 的成交后池价格，统一说明并固定；它与外部平台的成交均价 K 可能有差异。

一条 Swap 只计算一次 quote 侧绝对金额，不能把两边成交额相加。价格 OHLC 固定池，成交量默认也固定池；另存 `volumeAllPoolsUsd` 供展示，不能把全部池量混称主池量。未来若改聚合口径，必须换 series/version。

每分钟 `[openTs,closeTs)` 从有序交易取 O/H/L/C、volume sum；5m/15m/1h 从完整 1m 聚合。实时桶持续更新；策略只读已收盘且扫描水位已经越过桶结束时间的桶。建议安全等待 5s 为工程初值，不代表链的正式最终性；另记录确认策略与 reorg 检测状态。

无交易且扫描完整：可用上个 close 生成 synthetic 平线，volume=0。无数据或 RPC 缺口：quality=partial/unknown，绝不伪造零量平线。synthetic 不算箱体往返、pivot、拉升或突破的证据。RSI 可用连续 synthetic close 保持时间周期，但实际交易覆盖不足时不发送过热事件。

主池选择：episode 创建前用截至当时过去 1h 成交额最大的可计价池；新币不足 1h 用已有覆盖窗口，至少 5m，确定性并列排序为 poolId。episode 内禁止静默换池；主池迁移时终结旧 episode、开新 series、重新预热。若两个池持续价格差异超过 10%（工程值），标冲突并暂停确认，不挑高价池制造突破。

### 5.3 报价、市值、历史覆盖

现代码的 `marketCapUsd` 是价格乘总供应量，没有流通供应量证据，所以新卡片统一显示 **FDV（市值代理）**。供应量按时点快照存储，不用今天的供应量倒算历史。无法获取历史供应量的序列仍可做价格形态，但 3–5M 和 1–2M 条件 unknown。供应变化造成的 FDV 新高不算价格突破。

ETH/WETH 历史交易必须匹配当时 USD 报价；本地从启动开始每分钟留报价，历史缺口由经过验证的 provider 补。不得用当前 ETH 价换算整段历史。USDG=$1 只是 `peg_proxy`；卡片/回测记录这一假设，若取得可靠现价且显著偏离（建议 2%），暂停固定锚定计算。报价 unavailable 保留原始日志并重试换算，不能一边推进游标一边丢成交。

报价关联采用事件时点之前最近一条报价，默认相距不超过 120s；不能使用该分钟结束后才知道的报价 close 为分钟内交易定价。来源只提供分钟 close 时，以该报价真正可用时点之后的交易才能引用；历史资料后来补齐可以修复历史 series，但 availableAt 必须保留，回放不能提前获得。供应量同样按时点匹配，代币元数据定时刷新并记录异常变更；历史无法证明供应量时保持 unknown。

历史启动两种模式都必须可用：

1. **本地积累默认**：从当前开始可靠采集；新币满足完整初始段即可工作；二段通常需要第一波 + 至少 48h 箱体，期间状态 `history_warming`。不虚构立即可用。
2. **受控历史回补**：验证 RPC 日志和历史报价能力后，针对候选回补，默认 lookback 7 天；既取 Initialize 也取 Swap，完整度逐池记录。外部 OHLCV 需核对链/CA/池/周期/时区/价量口径/分页完整性，并单独 series；没有已验证接口就不要杜撰 URL。

coverage 表记录每池连续区间与缺口，水位表示“连续完成至此”，不能用最大 block 代替。真实区块 hash 检测到重组时回滚受影响事件与 K 线，重放状态；已通知信号追加 `data_corrected` 修订，不删除历史让失误消失。

### 5.4 保留与扫描预算

建议原始 post swap 保留 7 天，1m K 14 天，5m/15m/1h K 90 天，episode / signal / evidence 180 天，题材首次出现摘要长期保留。以上为起始预算，不是必须扫描全链 7 天所有 Swap。事件量大时允许压缩/归档原始事件，但待聚合、待回补、reorg 窗口和未终结 episode 引用的数据不能提前裁剪。

保护注册表内活跃池免受旧 24h prune；新模式可以将池元数据复制至 post 表并只读该表，或修改共享 prune 保护引用，选一种贯彻。维护必须分批小事务，避免同步 SQLite 长时间阻塞实时扫链。

候选分层：所有可识别新池进入轻量 registry；过去 15m 有交易的新币与外部/人工 CA 做优先采集；进入二段追踪后即使最近 5m 安静，也留在 watchlist。新币重点覆盖 24h 内、二段追踪默认 14 天以内（工程值）；14 天是总体生命周期预算，不是箱体可以横 14 天。

第一版预算建议：hot 200 个（每个闭合 1m 桶评估），warm 1000 个（5m/15m 闭合时评估）；超出采用有记录的队列，不静默截断成“没机会”。已有有效 episode 优先，新增候选按过去窗口成交额和等待时间排序。历史队列 RPC 并发 2、实时独立预算；不得让回补等待阻塞实时。

## 6. 策略 A：二段横盘 SECOND_LEG

以下除 48–96h 与 3–5M 外均为**待回放校准的工程初值**。目标是可解释、因果、不重绘，不能宣称精确复刻主观读图。

### 6.1 公共 pivot 规则

用已收盘 close 做方向变化节点，high/low 仅补充影线风险。在上行模式维护 running max；从 max 回撤达到阈值时确认前一个高点，记录 `extremeTs` 和当前 `confirmedAt`，转为下行模式。在下行模式维护 running min；从 min 上涨达到阈值时确认低点，再转上行。相同价格取最早极值；一次新 close 最多确认一个节点，next bar 才能确认相反节点。

绝不能把 confirmedAt 回填成 extremeTs 后当作可提前交易的信号。同 K 内先 high 后 low 还是先 low 后 high 不可从 OHLC 得知，故形态节点只用 close。缺口、series 切换重置未确认节点。

### 6.2 前置第一波和回落

二段用 15m close 为主，1h 图只展示上下文，不另加旧指标门。首次完整采集后，以第一个真实 close 初始化低点；使用 20% 方向变化 pivot。

找到顺序为 low L → high H 的已确认节点，满足：H/L≥2，低到高历时≤24h，高点后 close 回撤≥25%。如果 20% 回撤已确认高点，但未达 25%，继续等待。任何 high 后 close≤H×0.20（累计回撤≥80%）则本次第一波作废，不做“归零反弹二段”。

可同时记录多个第一波候选，但每个 token/series 只激活最近一个已完成回落的候选；激活后冻结 L、H 和确认时间，未到终态不能由新局部高点重置周期。没有第一波覆盖，状态 `missing_first_leg`；不能单看横盘就认定“二段”。

### 6.3 建箱与横盘定义

回撤 25% 首次成立的那根 15m close 为 `rangeStartTs`，从此计时，不因为来回小破位重启时钟。前 24h 是建箱窗口；它未通过就将该第一波 episode 标 `range_rejected`，不滑动挑后面最好看的 24h 来规避时间限制。

在该完整 24h 的所有非 synthetic 15m close 上，定义：

```text
Lbox = Q10(close)
Ubox = Q90(close)
Mbox = median(close)
width = (Ubox - Lbox) / Mbox
slope24h = OLS(close ~ elapsedHours).slope × 24 / Mbox
```

quantile 固定 linear interpolation（排序后索引 `(n-1)*q`）；OLS 自变量是真实经过小时，禁止用样本序号替代缺时。有效建箱要求：`0.15 ≤ width ≤ 0.60`，`abs(slope24h) ≤ 0.10`；至少 70% 预期桶有真实交易；所有预期桶扫描完整。这样排除几乎没交易的平线和持续单边下跌。0.60 是相对中位价宽度，不是相对下沿的涨幅。

24h 完成后冻结 Lbox/Ubox/Mbox，不随跌势下移边界“拯救”箱体。整个箱体截至评估时的 15m close，至少 80% 落在 `[0.95×Lbox,1.05×Ubox]`，OLS 日漂移绝对值仍≤0.10，每个滚动 6h 真实交易桶占比≥70%。这些是研究性过滤，卡片可解释，不是旧 holder/volume 阈值。

来回横至少出现 3 次交替区域访问：lower → upper → lower 或 upper → lower → upper。lower 为 `close≤Lbox+0.25*(Ubox-Lbox)`，upper 为 `close≥Ubox-0.25*(Ubox-Lbox)`；同一区连续多根只算一次，跨区确认至少间隔 4 根 15m 桶。计数只用真实成交桶，可从建箱 24h 数据计算，但最早可用时间仍为建箱完成后。

小破位允许：close 低于 Lbox 但≥0.92×Lbox，最多连续 2 根，随后 2 根内必须至少一根收回 Lbox；这段先标 `reclaim_pending`，收回前不发确认。任何 close<0.92×Lbox，或连续 3 根 close<Lbox，或超过回收期限，均失效。影线 low 跌破不单独当作确定 close 破位，须在卡片显示影线风险。

### 6.4 状态与推送

```text
FIRST_LEG_TRACKING → RETRACED → BUILDING_RANGE → RANGE_TRACKING
→ READY (48h ≤ rangeAge ≤ 96h)
→ BREAKOUT_CONFIRMED 或 INVALIDATED 或 EXPIRED
```

- 24–48h 的合格箱体只保存在本地观察列表，默认不发 TG。
- 48–96h：前置第一波、箱体、往返、size_band、数据完整度、叙事门全部 pass，首次发 `SECOND_LEG_READY`。不是买入成交指令。
- 突破：在未过期的 READY 箱体中，连续 2 根真实 15m close>1.03×Ubox，发 `SECOND_LEG_BREAKOUT`。不额外要求旧成交量阈值。触发快照冻结箱体数值。
- 两根确认完成时已超过 96h：只发/记录过期，不追溯成有效二段。48h 以前先突破：记录 `early_breakout`，不伪装成熟二段，必要时由新币/百万分支单独处理。
- `rangeAge>96h` 未突破为 EXPIRED。恰好 96h 仍可确认；判定顺序：数据/深跌/破位 → 超时 → READY/突破。
- READY 后失效或过期，编辑原卡且发一条简短关联提醒。未曾发卡的失败只记日志。
- 突破后继续看 24h：连续 2 根 15m close<Ubox 记 `BREAKOUT_FAILED`，并保留 RSI 事件；箱体 96h 截止不再撤销已经及时确认的突破。

新第一波 episode 只能在旧 episode 终态后，以终态之后确认的新 low→high 重新满足前置要求产生，不得用同一 H 每天创建新箱体。这样避免横盘五六天后又被改名成“第二天”。

## 7. 策略 B / C：新币拉扯与百万关口

### 7.1 NEW_PULLBACK：新币两个完整回撤周期

币龄以该代币最早可信交易时间为准（firstTradeTs），部署时间另记。若只知道某个新池的年龄，不知道 token 更早是否交易，显示 `age_unverified`，不能把老币重建池当新币。默认新币≤24h，至少有 5 根真实闭合 1m K。使用 1m close，5m 仅展示背景。

第一波定义：从 firstTradeTs 后最初 5 根真实 1m close 的中位数 B 开始，60 分钟内 running high H0/B≥2。该早期段缺失则 `missing_launch_history`；不能拿被发现后的第一笔当作发行价。几百 K 的底部是作者举例，不设成精确 $300K 必须买。

60 分钟窗口从 firstTradeTs 起算；B 必须等第五根真实 K 闭合后才能使用，H0 只跟踪此后可用的 close。此前已经完成、无法事前确认的超早拉升记为未覆盖，不回填触发时间。

以 H0 开始下列因果状态机，H0 在首次有效回撤前随新高更新，回撤开始后冻结当前 cycle 的峰值：

```text
IMPULSE → DIP1 → REBOUND1 → DIP2 → REBOUND2 → CONFIRMED
```

每个周期按 1m close 处理：

1. 相对该周期峰值下跌达到 12%，进入 DIP；记录持续更新的最低 close D。
2. 回撤超过 45% 则 episode `deep_dump` 失效。
3. 从 D 反弹至少 10%，且 close≥D+0.60×(peak-D)，才确认 REBOUND；从 DIP 第一根到确认需 2–30 分钟。
4. REBOUND1 之后维护第二周期峰值（起点为确认反弹的 close）；DIP2 第一根必须晚于 REBOUND1，至少间隔 2 根真实 1m K，不能复用第一轮低点。
5. D2≥0.90×D1，且总共两轮从 DIP1 起点至 REBOUND2 确认≤90 分钟。
6. REBOUND2 当前价距离 D2≤25%，超过记 `extended_rebound` 本次放弃推送；不持续追高等待更高价“更确认”。

以上都成立且叙事 pass，发 `NEW_PULLBACK_CONFIRMED`，附 H0、D1、D2、两次确认时间、当前距第二低点的幅度。最多一张主卡；第三次下跌不是新的入场条件。确认后 30 分钟内再从确认后 running high 下跌≥12%，发 `THIRD_DIP_RISK` 一次；或者 close<0.95×D2，发 `STRUCTURE_INVALIDATED`。先有数据故障就标数据不可用，不能把缺报当风险解除。

同一 token 默认只做一个 launch episode。新币超过 24h 时退出该分支；之后可进入二段独立 episode。不要给“第三次也只亏 10%”设置收益上限，实际价格跳空/税费/滑点可能完全不同。

### 7.2 MILLION_RECLAIM：1–2M 关口回踩后重新新高

独立于 B 的增强分支，同样只对≤24h 且初始交易历史可信的代币启用，1m close + 当时 FDV。没有价格历史/供应量时点，不触发。

1. 首次从 FDV<1M 收盘进入 [1M,2M]，进入 `AT_GATE`；从 0.9M 一根跳到 2.5M 记 `gate_skipped`，首版不猜测中间已经完成关口。
2. 进入关口后维护 running peak 的 price 与 FDV；首次价格回撤≥15% 冻结 peak，进入 `PULLBACK`。必须在进关口后 60 分钟内发生，否则本次 gate 过期。
3. 回撤最大≤40%；DIP 后≤30 分钟内连续 2 根真实 close 同时满足 price>冻结 peakPrice×1.02、FDV>冻结 peakFdv×1.02，确认“快速收复并新高”。供应量变化导致只有 FDV 新高不成立。
4. 叙事 pass 时发 `MILLION_RECLAIM_CONFIRMED`。每个 launch episode 一次；与 B 在同一根 K 命中时合成一个事件组、一张消息，列出两条理由。
5. 触发后 30 分钟内 close 跌回本次回调低点以下，发失效；否则进入通用跟踪。1–2M 是此前经过的关口，不要求最终突破时 FDV 仍≤2M。

旧题材若命中 B/C，最多发 `SPECULATIVE_WATCH` 观察卡，不显示标准确认标签；不允许在二段 READY 卡上悄悄把叙事条件当可选。

## 8. RSI 与分批退出提示

默认 `RSI(9)`，source=close，Wilder RMA；新增 `signalSmoothingLength=9`、`signalSmoothingType=SMA` 仅作辅助显示。帖子“9/9”无法确认第二个 9 是何种设置，所以卡片注明暂定，不能称与作者软件完全相同。不能误用 Stoch RSI。TradingView 对 RSI 及额外平滑线有独立说明，平滑参数不是第二次计算 RSI。[RSI 定义](https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/)；[平滑设置说明](https://www.tradingview.com/support/solutions/43000742042-i-see-a-smoothing-section-in-an-indicator-s-settings-what-does-it-do/)。

实现约定：n=9，delta=close[t]-close[t-1]，gain=max(delta,0)，loss=max(-delta,0)。最初 9 个 delta 用算术均值初始化 avgGain/avgLoss，之后 `(prev×8+current)/9`；RSI=`100-100/(1+avgGain/avgLoss)`。avgLoss=0 且 avgGain>0 返回 100；avgGain=0 且 avgLoss>0 返回 0；两者均为 0 暂定返回 50，并写明这是本项目约定。前 10 个连续 close 才能有首个 RSI，9 个有效 RSI 才能有首个 SMA9；推荐累计至少 90 个桶作为稳定预热，只有最小样本时标 `short_warmup`。

默认主周期：二段 15m，新币/百万 1m。不在多个周期任意挑最大的 RSI 发卡。上下参考线 80/20；raw RSI 首次从<90 到≥90 发 `RSI_OVERHEAT`，SMA9 不参与这条阈值。持续≥90 不重复；raw RSI 连续 2 根≤80 且距上次事件至少 30 分钟才重新武装。初次开始跟踪时已经≥90，可发一次“首次观测已过热”，不要冒称刚上穿。

只对已推送/人工关注且仍在跟踪期的代币发 RSI，避免全市场过热刷屏。最近 20 个目标周期桶至少 70% 有真实交易，否则仅本地记录。默认跟踪自最后形态确认起 24h；READY 则跟踪至过期/失效；人工 watch 可显式续期。失效当天可保留观察，但不发“风险已解除”。

文案：“RSI(9, 1m)=92，进入过热区；请结合持仓检查是否分批减仓。”80/20 是参考线，RSI<20 不自动产生抄底信号，90 也不是顶部保证。

可选 `referenceEntry` 由人工导入价格、数量、时间。只展示相对人工参考价的价格变化，不标净收益。若未导入，显示“相对首次信号价 +x%”，不能冒称盈利。25% 默认解释为原始参考仓位的四等份（四份合计 100%），只显示说明，不维护“已卖出”状态；用户若需要按剩余仓位 25% 或实盘持仓，作为未来独立需求。

## 9. 叙事分析与 DeBot：有证据才提升信号

### 9.1 必须交付的叙事最小闭环

首版必须有**人工结构化导入 provider**，保证没有付费搜索/LLM 账号时仍可完成叙事复核并闭环。自动 provider 是可选加速：采用可配置模型端点 + 可核查的网页/项目资料采集，不依赖某个 Grok 产品，也不假定 LLM 仅收到 CA 就知道真实叙事。实现 agent 需先列可用搜索/社媒数据源和费用限制；没有数据源时返回 unknown。

每份报告包含：

```text
reportId, chainId, ca, version, analyzedAt, availableAt, validUntil
status: pass | watch | reject | unknown
category: technology | science | stock_related | meme | other | unknown
summary: 一句解释概念
caBinding: verified | unverified | conflict
novelty: new_in_index | repeated | insufficient_history
marketResonance: supported | weak | unknown
previousSameChainExamples[]: CA、firstObservedAt、概念、证据
claims[]: 陈述、url/sourceId、内容摘录、publishedAt(可空)、fetchedAt、是否已核验
modelId, promptVersion, inputHash, corpusVersion, confidenceLabel
reviewer: human | model；reasonCodes[]
```

`pass` 必须同时满足：

1. CA 与所分析项目绑定有证据：项目公开页面/已核验公开账号明确列出 CA；来源冲突则 conflict。仅同名、同 ticker 不够。
2. Robinhood 首版叙事偏好为科技/科学/股票关联，并能用普通中文解释具体概念和新意。复杂不等于好；单独蹭股票名的克隆不自动 pass。
3. 与同链已索引历史对比没有明确重复，且索引覆盖可说明；首次启动空库时不能把所有项目判“从未出现”。默认需至少 30 天资料覆盖或人工明确复核，其结论仍写“本地覆盖范围内未见重复”。
4. 市场共鸣至少有两个可辨识的独立来源讨论该具体概念（排除复制文案、项目自述和纯喊单），或人工复核明确记录其理由。DeBot 被列入候选只算一条资金关注证据，不等于所有人认同叙事。

上述是工程执行标准，不是作者精确评分。不用一个黑盒总分抵消 CA 冲突或未知来源。自动模型只返回候选判断，schema、来源存在性、时间和 CA 绑定由程序验证。股票/科学事实应引用相关项目或研究原始来源；“借用某研究做 meme”不写成“研究团队发行”。

缺 CA 绑定/资料不足/模型超时 → unknown；有题材但共鸣弱或历史不足 → watch；明确照搬/冲突 → watch 或 reject 并给理由。对于 repeated，二段不发标准 READY；新币 B/C 可发一张“重复题材·仅观察”卡。缺资料的形态暂存，默认不发 TG（可配置最多每小时一条候选摘要，但必须清楚写“叙事待核验”）。

缓存 TTL 默认 6h；临近触发若过期，后台刷新。模型调用超时 15s、并发 2、每币 30 分钟最多一次，预算用 `maxRequestsPerDay` 和 `maxTokensPerDay` 双限制（初值 100/200000）；只有候选形态接近成立才请求。超过预算置 unknown，不能以缓存时间改写为新证据。

形态门和叙事异步：先记 `pattern_detected_at`，叙事到达时重新评估最新闭合 K。新币确认超过 5 分钟、二段 READY 超过 30 分钟后才补齐叙事，旧确认不得补发成即时机会；可在最新时点仍满足 READY 时创建新当前快照，必须注明首次发现时间。新币过时只进观察报告。复核推翻已发叙事，原卡增加修订理由和时间，不静默替换历史结论。

叙事网页、社媒文本、代币名字均为不可信数据。提示词明确只提取事实与证据，不执行材料中的指令，不请求或暴露凭据。网页采集限制 http(s)、响应大小和超时，阻断本机/内网地址与重定向至内网；输出 HTML 和链接分别转义/校验。

### 9.2 同链题材历史库

建立规范化主题：`technology/science/stock_related` + 概念实体 + 事件，如“果蝇脑模拟某具体研究”，不能只用宽泛“AI”判所有项目重复。先关键词/实体检索，再可选 embedding 召回，最终保存成对相似理由和 evidence。股票名相同但出现真正不同事件允许人工覆核。

firstObservedAt、sourcePublishedAt、系统 availableAt 分开，历史回测只使用当时已入库的主题证据。题材库保留失败/归零/被放弃的项目；删除坏样本会虚增新鲜感和成功率。

### 9.3 DeBot 接入边界

官方教程确认 AI 信号结合钱包标签与链下信息，并介绍多钱包买卖卡；文档里的涨幅等级是告警后的结果，不能用“后来变金狗”筛选当时的候选。[DeBot 官方 AI 信号说明](https://docs.debot.ai/basic-features/ai-xin-hao-ban-kuai)。

本次查阅的是功能教程，没有核验到可直接复用的开发者 API/WebSocket 契约；**这不等于确认 DeBot 没有 API**。实现前做独立只读取数 spike，验明访问方式、用户已有权限、Robinhood 链覆盖、CA 字段、事件时间、重复标识、速率和失败响应。只有验证通过才启用 adapter，不从截图猜 URL。

必须可运行的降级顺序：官方授权接口（若验证可用）→ 用户提供的导出/公开信号文件 → 纯链上发现 + 人工 CA。首版不把登录抓取做成必选基础设施；若采用用户可访问页面，需评估会话过期和 DOM 变更，不能绕过验证码或付费权限。

标准化只导入：链、CA、买/卖 signal、sourceEventId、发生/观测时间、原始证据引用、钱包数等可证明字段。字段缺失保留 null；“3 个聪明钱包”必须标来源，不用 `Swap.sender` 冒充真实用户，也不用旧 FOMO 持币数代理。资金卖出信号可给已关注币发“外部来源卖出提醒”，但不自动覆盖技术形态。

DeBot unavailable 不阻塞纯链上候选；不得把自研规则标“DeBot AI”。推广短链不进入配置或默认 TG 卡。

## 10. 持久化、事务与确定性

新表统一 `post_` 前缀，实施时提供幂等版本迁移。下表是必需语义，列名可按实现规范微调，主键与索引需要落地。

| 表 | 主键 / 唯一键 | 最小存储与索引 |
|---|---|---|
| `post_tokens` | chain_id, ca | first_trade_ts/证据、first_seen_at、age_quality、tier、track_until；tier/next_due 索引 |
| `post_pools` | chain_id, pool_id | CA、quote、方向、小数位、init block/time、active；CA 索引，供旧裁剪隔离方案 |
| `post_discoveries` | source, source_event_id, chain_id, ca | eventTs、observedAt、证据；同 CA 多来源不覆盖 |
| `post_swaps` | chain_id, block_hash, tx_hash, log_idx | pool、序号、raw 数值、price/volume、quote_id、时间；pool/time 与 block 索引 |
| `post_quotes` | source, asset, quote_ts | USD、availableAt、quality、版本；历史匹配只找合规时点 |
| `post_supplies` | chain_id, ca, observed_block | raw totalSupply、来源、availableAt；不可伪造历史 |
| `post_coverage` | chain_id, pool_id, stream, from_block | to_block、水位/缺口、last_hash、状态；实时/回补分开 |
| `post_candles` | series_id, timeframe_sec, open_ts | OHLCV、FDV、quality、closed、synthetic、availableAt、revision |
| `post_series` | series_id | pool/source/quote/supply 口径、有效期、切换原因 |
| `post_episodes` | episode_id；唯一 chain/ca/strategy/anchor_id/version | state、series、冻结边界、pivot、时钟、last_processed_bar、config_hash、revision |
| `post_narratives` | report_id | §9 字段、证据 JSON、版本/TTL；chain/ca/time 索引 |
| `post_topics` | topic_id | 概念实体、first_observed、覆盖说明；关联 CA 用单独关系表 |
| `post_evaluations` | evaluation_id | rule 结果、输入 hash、asOf、availableAt、reason；保留被拒样本 |
| `post_signals` | signal_id；唯一 episode/event_type/event_seq | 首次发现/确认时间、不可变输入快照、版本、group_id、quality |
| `post_outbox` | outbox_id；唯一 signal_id/op/revision/destination/mode | pending/sending/sent/unknown/failed/expired、attempt、lease、due、deadline、payload、message_id |
| `post_message_refs` | group_id, destination, mode | chat_id、message_id、delivered、last_revision、首次发送时间 |

SQLite `BEGIN IMMEDIATE` 短事务内：检查 episode 的 `last_processed_bar` 与版本 → 计算后的状态落库 → insert signal → insert outbox → commit。异步网络、LLM 和 Telegram 不得放在事务里。计算可在事务外，用 CAS `revision` 防止旧任务覆盖新状态。相同闭合 K 重放不能二次计数 pivot 或重复创建信号。

采集也有自己的原子提交：原始事件与该批采集游标一起提交；USD 换算、K 线聚合分别维护 durable cursor 和失败状态。只有所需事件已定价并聚合，才能推进“策略可用水位”。这样报价故障不会迫使原始日志丢失，也不会将“原始采集完成”错误当成“K 线完整”。

`signalId` 由 episode、eventType、eventSeq 生成稳定 id；不以 `Date.now()` 作为唯一去重依据。episode id 的 anchor 是已确认第一波/launch 事件，而非进程启动时刻。配置变更保留旧 episode 的 config snapshot，新 episode 使用新版本；重放测试显式新 runId，不可污染 live outbox。

事件修订追加 revision，不能就地改原始“当时看到什么”。单独记录 eventTs→ingest→bar close→evaluation→outbox→TG acknowledgment 的延迟。

## 11. Telegram 消息设计与发送可靠性

### 11.1 消息类型与优先级

| 事件 | 动作 | 优先级 |
|---|---|---|
| SECOND_LEG_READY | 主卡一张，之后同 episode 编辑 | P1 |
| SECOND_LEG_BREAKOUT | 编辑主卡 + 一条关联简讯 | P1 |
| NEW_PULLBACK / MILLION_RECLAIM | 同一 token/同一桶同时命中合为一张 | P1 |
| INVALIDATED / BREAKOUT_FAILED / THIRD_DIP_RISK | 原卡明确标失效 + 简讯，不撤掉失败样本 | P0 |
| RSI_OVERHEAT | 一条关联提醒，有重新武装和冷却 | P0 |
| 叙事修订 / 数据纠正 | 编辑 + 严重时简讯 | P0/P1 |
| repeated 题材观察 | 每 launch 最多一张 | P2 |
| pending / 建箱 / 无资料 | 本地，默认不推 | — |

P0 优先但不可永久饿死 P1；同币同一分钟多个风险理由合并。优先级只在未发队列排序，不抢占已经发出的请求。给同币合并 reason codes，保留每个原始 signal id，不能因跨策略冷却把失效信息吞掉。

### 11.2 卡片模板（虚构渲染样例，不是实测信号）

```text
🟡 二段观察就绪 · 示例币 SAMPLE
Robinhood · CA: 0x…
价格 $0.0041 · FDV（市值代理）$4.10M
箱体 $0.0034–$0.0047 · 已横盘 57.5h
第一波 2.8×；其后最大收盘回撤 54%
箱内收盘 86% · 区域往返 4 次 · 15m
3–5M 口径：FDV 代理（暂定）

叙事：某具体科技事件的 meme 延伸
本地历史范围内未见重复 · 证据 2 条
当前条件：已收盘形态成立，尚未突破
观察失效：收盘 < $0.003128 或持续跌破箱底
箱体截止：09/14 08:30（UTC+8）
RSI(9,15m) 64 · 行情截至 09/12 18:00
数据：完整；USDG 按 $1 代理；来源 chain
信号 SL-… · 规则 post_v1 / config 8位hash
[行情] [浏览器] [叙事证据]
```

```text
🟢 新币两次回拉确认 · 示例币 SAMPLE
CA: 0x… · 币龄 2h14m · 周期 1m
第一次：回撤 23% → 收复跌幅 71%
第二次：回撤 19% → 收复跌幅 66%
D1 $… / D2 $… · 当前距 D2 +18%
同时命中：1–2M 关口回踩后创新高（如有）
叙事：科技 / 有来源 / 本地新题材
失效参考：D2 × 0.95 = $…（非保证成交价）
确认 18:01 · 发送 18:01:08 · 信号 NP-…
```

```text
🟠 过热提醒 · SAMPLE · NP-…
RSI(9,1m)=92.1，首次进入 ≥90 区间
相对首次信号价 +37%（非实际持仓收益）
如已有利润，可检查是否按原始仓位 25% 分批减仓。
行情截至 18:16 · 不代表已见顶
```

必要字段：链/CA、信号类别、收盘确认时点、周期、关键数值、叙事状态、失效条件、数据质量、source、signalId。卡片不要堆旧 FOMO 指标。

HTML 文本转义 `& < >`，URL 单独校验并转义属性引号；token 名字不能注入链接。精简主卡至约 3500 字符预留空间；Telegram `sendMessage` 限制为实体解析后 1–4096 字符，超长按优先级裁剪证据摘要，CA 和关键条件必须保留。处理 429 的 `retry_after`，详见 [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage) 与 [ResponseParameters](https://core.telegram.org/bots/api#responseparameters)。

首版用现有的外链按钮即可，不做 callback 交易按钮，不强制新增 TG 命令接收器；人工导入通过 CLI。若添加 reply 关联简讯，需要扩展 Notifier 的 reply 参数并做 off 模式记录测试。

### 11.3 outbox 与恢复

当前 Sender 是内存队列，并会对网络失败直接重试；它不是持久 outbox，也无法区分“服务端已收但返回丢失”。post 模式应通过一个新增结构化发送结果接口，返回 `delivered(messageId)`、`definiteFailure(retryable, retryAfter)` 或 `ambiguous`，不要外包一层 outbox 后仍让底层盲重试四次。

必须行为：

- 发送前 lease 一个任务，确认未过 deadline，且该 signal 未被更高 revision 的失效事件替代。
- 数据确认和 outbox 入库原子提交；发成功再落 messageRef/sent。进程在网络前死掉可以安全重新排队。
- 网络超时/连接中断，以及服务端成功但落库前崩溃：任务为 `unknown`。Telegram sendMessage 没有本项目可依赖的客户端幂等键，不能声称跨网络恰好一次。默认不自动重复发 unknown 的新建主卡，记录运维待核对，可人工关联 messageId 或显式重发；因此可能漏通知，报告要计数。
- 已知 messageId 的 edit 可以重试；`message is not modified` 视为达到目标内容。找不到/不可编辑的消息时最多补一张带原 signalId 的修订卡，并记新引用；不能无限重建。
- 429 属于明确未成功，按 retry_after 重排；确定性 400 格式错误需修正文案或终结，403 权限错误进入 failed 并输出本地健康告警，不持续轰炸。敏感 bot token 不进入 URL 错误日志。
- 发送间隔暂沿用现有 3200ms 作为保守值，可配置。在 outbox worker 调度，避免任务被领取后又在底层队列等待很久导致过期；紧挨实际 HTTP 请求再次检查期限。
- 新币/百万通知 deadline 为确认后 5 分钟；二段 READY 30 分钟；突破 10 分钟；风险 5 分钟。逾期不补发成实时信号，进本地报告；仍有风险时可生成当前时点的新“状态提示”，写原事件时间。
- 重启恢复尚未终结 episode、采集游标、叙事任务和 pending outbox；过时事件只归档。lease 超时的 `sending` 一律按可能已发处理，不直接当 pending。
- `NOTIFY_MODE=off` 时所有 send/edit/remove/恢复均不得产生 TG 网络调用；本地 messageId 和真实 chat/message 引用按 mode 隔离。off→telegram 不将历史演练当作已送达，也不补发积压机会；telegram→off 不碰原真实消息。

## 12. 完整配置草案

下面是新配置文件的设计，不应覆盖当前 `config/rules.yaml`。全部字段必须做运行时类型/边界校验，未知 key 报错。百分比统一用 0–1 小数；倍率用 ≥1 数值；时间 key 自带单位。

```yaml
version: post_v1
chains: [4663]
scan:
  realtime_interval_ms: 1000
  closed_bar_grace_seconds: 5
  historical_concurrency: 2
  hot_limit: 200
  warm_limit: 1000
history:
  startup_mode: accumulate       # accumulate | backfill
  lookback_days: 7
  candidate_max_age_days: 14
  raw_retention_days: 7
  candle_1m_retention_days: 14
  candle_higher_retention_days: 90
  evidence_retention_days: 180
market:
  series_policy: frozen_pool
  price_conflict_max: 0.10
  stable_peg_deviation_max: 0.02
  require_complete_coverage: true
  real_bar_ratio_min: 0.70
size_band:
  mode: fdv_proxy                # fdv_proxy | volume_usd | off
  min_usd: 3000000
  max_usd: 5000000
  volume_window_hours: null      # volume_usd 时必须为正数，例如实验 24
  volume_in_band_ratio_min: 0.70
second_leg:
  enabled: true
  timeframe_seconds: 900
  pivot_reversal: 0.20
  first_leg_multiple_min: 2.0
  first_leg_max_hours: 24
  first_pullback_min: 0.25
  collapse_drawdown: 0.80
  seed_box_hours: 24
  ready_min_hours: 48
  ready_max_hours: 96
  box_quantiles: [0.10, 0.90]
  box_width_min: 0.15
  box_width_max: 0.60
  daily_drift_abs_max: 0.10
  inside_padding: 0.05
  inside_ratio_min: 0.80
  activity_window_hours: 6
  zone_fraction: 0.25
  zone_visits_min: 3
  zone_gap_bars_min: 4
  soft_break_max: 0.08
  soft_break_max_bars: 2
  reclaim_deadline_bars: 2
  breakout_buffer: 0.03
  breakout_confirm_bars: 2
  breakout_failed_bars: 2
new_pullback:
  enabled: true
  timeframe_seconds: 60
  max_age_hours: 24
  launch_baseline_real_bars: 5
  impulse_multiple_min: 2.0
  impulse_max_minutes: 60
  dip_min: 0.12
  dip_max: 0.45
  rebound_min: 0.10
  recovery_fraction_min: 0.60
  cycle_min_minutes: 2
  cycle_max_minutes: 30
  second_cycle_gap_real_bars: 2
  second_low_ratio_min: 0.90
  total_max_minutes: 90
  max_distance_from_second_low: 0.25
  invalid_below_second_low: 0.05
  post_confirm_risk_minutes: 30
million_reclaim:
  enabled: true
  gate_min_usd: 1000000
  gate_max_usd: 2000000
  gate_to_dip_max_minutes: 60
  dip_min: 0.15
  dip_max: 0.40
  recovery_max_minutes: 30
  new_high_buffer: 0.02
  confirm_bars: 2
rsi:
  enabled: true
  length: 9
  smoothing_type: SMA
  smoothing_length: 9
  reference_upper: 80
  reference_lower: 20
  overheat: 90
  rearm_below_or_equal: 80
  rearm_bars: 2
  cooldown_minutes: 30
  recommended_warmup_bars: 90
  real_activity_window_bars: 20
narrative:
  provider: manual              # manual | configured_auto
  required_for_standard_signal: true
  allowed_categories: [technology, science, stock_related]
  history_coverage_days_min: 30
  independent_sources_min: 2
  cache_ttl_hours: 6
  timeout_ms: 15000
  concurrency: 2
  min_refresh_minutes: 30
  max_requests_per_day: 100
  max_tokens_per_day: 200000
  pending_tg_digest: false
external_candidates:
  debot_enabled: false
  manual_import_enabled: true
notifications:
  min_gap_ms: 3200
  new_signal_ttl_minutes: 5
  range_ready_ttl_minutes: 30
  breakout_ttl_minutes: 10
  risk_ttl_minutes: 5
  ambiguous_send_policy: manual_reconcile
  followup_hours: 24
  reference_exit_fraction: 0.25
render:
  timezone: Asia/Hong_Kong
  locale: zh
```

校验交叉约束：48≤96，seed<ready_min，quantile 有序且在 (0,1)，dip_min<dip_max<collapse，upper>lower，overheat≥upper，rearm<overheat，retention 覆盖活跃所需窗口；mode=volume_usd 不允许 null window；关闭叙事硬门只能标 `experimental` 并限制演练报告，不能仍叫标准 post_v1 确认。所有固定常量若未在 YAML 中暴露，需集中到 versioned defaults（如 close≤H×0.2 的等价关系、gate 分支 24h 币龄），不可散落多个模块出现冲突值。

## 13. 实现顺序和可运行交付

### 阶段 0：确认现状和依赖

阅读本文件与相关源码，确认工作区其他修改。记录实际 Node 版本、chainId、RPC 历史日志能力、报价来源、DeBot/叙事 provider 可用性；只读探针输出脱敏报告。禁止因为文档列了接口就宣称接口已连通。无需修复所有旧 PnL 问题，它不在新模式关键路径。

产出 `docs/run/POST_DEPENDENCIES.md`：每个来源 verified/unavailable/unknown、证据日期、速率预算、启动积累/历史方案。自动叙事或 DeBot 未就绪不妨碍采用人工导入实现完整主链路。

### 阶段 1：数据底座与隔离

实现 mode/config、迁移、registry、规范化事件、真实时间、报价历史、OHLCV、coverage、retention；提供一份由真实事件算出 OHLCV 的可复算样本。旧模式行为回归，新模式不加载旧 FOMO/holder 依赖。没有这一步，不要先画 TG 模板伪装已识别二段。

### 阶段 2：确定性形态 + 人工叙事

实现 pivot/A/B/C/RSI 与手工 narrative provider；纯函数输入 candles + state + asOf，输出新状态 + evaluations + proposed signals，不直接发网络。`post-explain` 输出每个条件及拒绝/未知原因，能解释“为什么没推”。

### 阶段 3：TG 和恢复

接信号事务、outbox、post renderer、off recorder，完成合并/修改/失效/重启/模式切换演练。外部 provider 异常不阻塞引擎。此时应可用人工叙事 + chain 数据跑完整发现到本地 TG 文本闭环。

### 阶段 4：可选自动化来源

接验证过的自动叙事，建题材库；有已验证入口才接 DeBot。完成请求预算、缓存、CA 绑定和时序测试。报告清楚哪些字段来自链上，哪些来自外部标签/模型解释。

### 阶段 5：回放与持续验收

真实历史连续样本的逐时回放 + 至少 24h 禁发送观察；二段需覆盖完整第一波和至少 48h 箱体，因此依赖真实 7 天历史或本地继续积累，不得拿 24h 观察证明 2–4 天策略已验完。最后交付改动清单、配置、测试输出、覆盖缺口、示例卡和运行报告。

建议新增脚本（目前不存在；coding agent 实现后再运行）：

```text
npm run post:check-config
npm run post:dry-run       # STRATEGY_MODE=post_v1, NOTIFY_MODE=off
npm run post:explain -- --chain 4663 --ca <CA>
npm run post:import -- --file <validated-json>
npm run post:replay -- --fixture <path> --as-of <UTC> --output <isolated-dir>
npm run post:report -- --hours 24
```

测试必须使用 `FOMOT_DB` 的独立临时库，不读写 `data/fomot.db`。`post:replay` 内强制 off 并禁用实时 provider，不能被外部 `NOTIFY_MODE=telegram` 覆盖。不得在文档验收阶段尝试发送真实 TG。真实运行命令由实施交付明确提供，用户启用凭据与 `NOTIFY_MODE=telegram` 后才进入生产通知。

## 14. 测试矩阵与验收定义

| 类别 | 必测输入 / 故障 | 必须看到的结果 |
|---|---|---|
| 定价 | token0/token1、6/18 decimals、ETH/WETH/USDG | quote 方向正确、成交量不双算、代理口径明确 |
| K 线 | 同秒多 swap、跨分钟、乱序/重复回放 | OHLC 顺序确定、volume 幂等，父桶可复算 |
| 空桶 | 完整扫描无交易 vs RPC 丢一段 | 前者 synthetic，后者 unknown，不生成假横盘 |
| 历史 | 当前 ETH 价明显不同于历史价 | 不用当前报价重算过去；缺历史报价标缺失 |
| 市值 | totalSupply 改变 / 只有总供应量 | 标 FDV；仅供应变化不触发百万突破 |
| 主池 | 另一小池突然高价/主池切换 | 原 episode 不拼接，冲突暂停/新 series 预热 |
| 深跌 | 第一波后跌 85% 再横盘 | 拒绝二段，不能用后续横盘掩盖归零式下跌 |
| 时间 | 47h59m / 48h / 96h / 96h+1桶 | 边界按 §6；不重置箱体时钟 |
| 建箱 | 持续缓跌、极低量平线、无第一波 | 分别拒绝漂移/真实活动不足/unknown |
| 破位 | 允许范围内短破收回、持续 3 桶破底 | 短破等待再恢复；持续破位失效一次 |
| 突破 | 单根影线/单根 close/连续两根 close | 仅最后一种可确认，且不迟于 96h |
| 新币 | 一直下跌/两根红 K/跌拉跌拉/第三跌 | 只有两个完整独立周期确认，第三跌风险 |
| 新币过热 | 第二回拉距 D2>25% | extended_rebound，不追价推确认 |
| 关口 | 进入 1–2M 后回踩新高 / 跳过关口 / 慢回收 | 仅限时完成的有效路径触发 |
| RSI | 单调涨/跌/完全平、预热不足、持续≥90 | 100/0/50 约定；样本不足 unknown；不重复 |
| 叙事 | 同名不同 CA、抄旧题材、空历史库、资料注入 | CA 冲突不 pass；重复降级；空库非全新；不执行注入 |
| 外部源 | DeBot 重复/迟到/无 chain/不可用 | 去重、按 availableAt、未知链隔离、链上继续 |
| outbox | 状态落库后重启、429、403、send 超时 | 恢复幂等、退避、明确失败、unknown 不盲重发 |
| 修改消息 | 不可编辑、未改变、相反修订乱序到达 | 最多一次替代；未改变成功；旧 revision 不覆盖新 |
| 模式切换 | off→telegram→off，遗留 messageId | 演练不补发，真实消息不被 off 调用改动 |
| 保留 | 运行>24h、>48h、触发旧 pruneSwaps | 二段池和必须历史仍在，未知缺口显式记录 |
| 重组 | block hash 改变 / 同 tx 重新入链 | 原链事件回滚、不双算、受影响信号修订 |
| 无前视 | 同样数据截断到每个 asOf 再跑 | 结果等同逐桶 live replay；极值确认不能提前 |

关键验收门槛：

1. 新模式每种策略至少一份确定性成功路径、两份失败路径及边界 fixture；样例与规则公式可手算复核，不写镜像实现式测试。
2. 所有信号能导出实际 K 线、叙事证据、条件结果、配置 hash、可用时间、所用 series。没有条件解释的综合“AI 分”不合格。
3. 不把 unknown 当 pass，不继承任何旧指标门。失败项目和未推候选也要保留，统计漏检与拒绝原因。
4. 同一闭合桶重复处理、重启、重新拉历史，不新增同一个确定性 signal。端到端 Telegram 恰好一次不作虚假承诺；unknown 数量和处置清楚。
5. `NOTIFY_MODE=off` 用网络拦截断言验证 TG 调用为 0，覆盖初始化/恢复/编辑/错误路径，而不是只检查 send。
6. 对目标候选预算，记录 P50/P95/P99：采集延迟、K 线完成延迟、引擎计算、outbox 排队、消息确认、RSS、DB 日增长、coverage 缺口。工程目标为闭合且可用的桶到本地信号 P95≤2s；健康网络且无队列拥塞时 1m 收盘到 TG 确认 P95≤20s。未达如实报告，不以改变 confirmedAt 掩盖延迟。
7. 观察报告注明实际候选数和 RPC 条件；200 hot/1000 warm 是目标容量，不是本次已跑结果。消息拥塞需展示过期丢弃量，不能用无限排队获得“零失败”。

### 14.1 策略效果报告：验证形态与验证收益分开

形态识别通过不代表策略有正收益。保存所有候选、信号、拒绝和失败序列，按发现时可用数据回放，不只挑作者成功案例或 DeBot 后来标金狗的币。

第一版报告触发数、重复率、观察到确认率、失效率、覆盖率、信号后 5m/30m/1h/4h/24h 的价格变化、MFE/MAE，按 A/B/C、题材重复、新鲜证据、链/时期、size_band 模式分组。观测期不够用 censored 标记，停止交易/报价缺失保留失败或不可估类别，不能直接剔除。

“影子交易”只可选做：入场取信号真正可用后下一根有交易 K 的 open，加注明假设的手续费/税费/滑点与流动性限制；无可执行报价则标不可估。只用 OHLC 无法判定同根 K 止盈止损先后，采用保守顺序或交易级重放。25% 分批规则原帖没有具体目标价，不能随意补一个最赚钱的出场阶梯再称帖子收益。

历史叙事如果是今天让模型补写，必须标 `retrospective_narrative`，只能研究形态，不能当成当时已知的完整策略回测。参数按时间分训练/验证，锁定后在后续时期检验，并报告不同市场时期的结果；不默认当前仍是作者说的牛市。

## 15. 给 coding agent 的执行摘要

按 §13 分阶段实施，优先保证数据连续性与口径，再做形态和 TG。旧代码只复用基础设施，不复制旧指标和告警生命周期。遇到帖子歧义使用本文默认值并记录为 assumption，全部版本化；遇到 provider 未验证先用人工导入或本地积累，不能杜撰 API、价格、叙事和回测结果。

完成定义是：**链上候选/人工叙事能够走到可解释信号与可靠通知出口，A/B/C/RSI、失效、重启、去重、未知数据、无前视都有验证证据，配置和运行文档可交接**。自动叙事/DeBot 的启用状态单独验收，不把 stub 计为已完成接入；二段历史不足要明确写尚待积累，而不是声称已经实盘验收。

本次文档编写未启动服务、未修改 .env、未改生产数据库、未发送 Telegram，也未实现上述新增模块。
