# FOMOt

复刻 Telegram「FOMO NOW」那种代币监控推送：按节拍扫描 Robinhood Chain 上的活跃新币，
命中规则就推一张告警卡片，+0.8s 采集持币初值、+5m1s 复核并改写原消息。

## 已核实的链上事实

以下全部是对着主网实测确认的，不是查文档抄来的：

| 项目 | 值 | 怎么确认的 |
|---|---|---|
| Chain ID | `4663` (`0x1237`) | `eth_chainId` |
| RPC | `https://rpc.mainnet.chain.robinhood.com`（主）<br>`https://rpc-robinhood.blockmachine.io`（备） | 见下方「备用 RPC」 |
| 出块间隔 | **约 100ms**（10 块/秒） | 相隔 100 块的两个区块时间戳差 10 秒 |
| 浏览器 | `https://robinhoodchain.blockscout.com` | 免鉴权、免费 |
| DEX | Uniswap V4，PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` | 5 个事件签名的 topic0 逐一比对通过 |
| 计价资产 | NATIVE ETH（66x）、USDG `0x5fc5…d168`（**6 位小数**，47x）、WETH（5x） | 196 个新池样本统计 |
| 发射模板 | EIP-1167 克隆，实现合约 `RobinVistaLaunchToken`，工厂 `0x4A3e797B…` | Blockscout `getcontractcreation` |
| 新池速率 | 约 5～7 个/分钟 | 多次采样 |

### 三个坑（都是实测踩出来的）

1. **`eth_getLogs` 的限制是「命中日志 ≤ 10000 条」，不是区块范围。**
   viem 会把它显示成 `Missing or invalid parameters`，极具误导性；RPC 原始报文是
   `{code:-32000, message:"logs matched by query exceeds limit of 10000"}`。
   Swap 约 5.2 条/块（800 块 = 8407 条，1600 块就超限），所以按事件分别过滤 + 范围自适应。

2. **代币的部署区块 ≠ 建池区块。**
   实测 AGI 的池子比代币部署晚了约 100 分钟。按建池区块去扫 Transfer 会严重漏算持币人
   （AGI 会算成 127，实际 639）。必须先取真实部署区块。

3. **公共 RPC 不是归档节点，别想用 `eth_getCode` 二分查部署区块。**
   往回 1000 块能查，10 万块就报错。二分会把「查询失败」当成「尚未部署」，静默返回一个
   偏晚的区块——实测某个币因此少算了 87% 的持币人。静默给错答案比直接失败更糟，所以不做。
   好在历史**交易**和**区块**能查（被裁剪的只有 state），所以走
   「Blockscout 取部署交易哈希 → RPC 查交易在哪个区块」这条路。

   Blockscout 公共实例还会限流（`{"message":"Too many requests"}`），所以客户端带令牌桶，
   并且**先过量价门再查币龄**——绝大多数候选在花掉一次 Blockscout 调用之前就被筛掉了。

## 持币人数怎么算

不用 Blockscout 的 `holders_count`——新币在 +0.8s 时它多半还没索引完。
改成直接放代币自己的 Transfer 日志重建余额表：

```
AGI    自建 661  vs  Blockscout 639   偏差 +3.4%
Inkky  自建  84  vs  Blockscout  85   偏差 -1.2%
```

一次 getLogs 就能同时拿到精确人数、每个地址的余额、Top10。命中触发前会预热，
所以 +0.8s 的快照只需要增量扫几十个区块。

## 备用 RPC

官方公共 RPC 明确写着「无归档、无 SLA」，实测确实会抖：某轮 7 次触发里 3 次因为
同一时刻的一次 RPC 抖动而失败。所以配了双端点，**严格按顺序降级，不按延迟排序**——
低延迟节点不一定数据全。

候选是逐个实测筛出来的（`npm run probe-rpcs`），注册表上列的大多不能用：

| 端点 | 结果 |
|---|---|
| `rpc.mainnet.chain.robinhood.com` | ✅ 主端点 |
| `rpc-robinhood.blockmachine.io` | ✅ 与主节点逐条一致（同范围 Init 34 条 / Swap 4327 条），历史交易可读，**而且没有 10000 条日志上限**（2400 块返回 16318 条） |
| `robinhood-rpc.publicnode.com` | ❌ 只服务最近约 20 块，再往前提示 "Archive requests require a personal token" |
| `robinhood.api.pocket.network` | ❌ 同上，"historical state is not available" |
| `rpc.arrowrpc.com` / `rpc.ordofi.network` / `rpc.nodeflare.app` | ❌ 返回 HTML，不是 JSON-RPC |
| `lb.routeme.sh` | ❌ 公共额度已耗尽 |

**筛选标准不是「能连上」，而是「返回的数据和主节点逐条一致」**——
一个静默返回不完整日志的节点会让持币人数和成交量直接算错，比没有备用更危险。

用 `RPC_URLS`（逗号分隔）覆盖默认顺序。降级会打 WARN 日志，当前端点记在
健康指标 `rpc_endpoint` 里。

## 数据分两半

| | 来源 | 状态 |
|---|---|---|
| 市值 / 成交量 / 全链持币人 | 链上，公开免费 | ✅ 全通 |
| Fomo 用户占比 / Top10 该币累计收益 / 粉丝数 / 24H 盈利榜 | FOMO App | ⚠️ 需要你自己的账号 |
| Top10 的**全平台 24H** 收益 | FOMO App | **默认开启**，完全在持币关键路径之外：到期前预取，没就绪就先出卡（`采集中…`）再原地补。窗口对齐整点、十人共用，缺一人即 `n/a` + 原因。`FOMO_PLATFORM_PNL=0` 可关 |
| Top10 的**全平台 24H 盈利人数** | 同一批收益记录 | 独立字段，与「该币累计收益」那行的盈利人数各算各的 |

`prod-api.fomo.family` 未鉴权一律返回 **430**，所以社交那半只能用登录态浏览器抓。
原版卡片最后一行的 `浏览器→入库 64ms` 就是这个管线的延迟埋点——他们也是这么干的。

### FOMO 接口（抓登录态浏览器的响应逐个对出来的）

两个端点撑起卡片的整个社交部分：

| 端点 | 内容 | 用在卡片哪里 |
|---|---|---|
| `/v2/leaderboard/24h` | 150 人的 24H 盈利榜 | `#28 frank`、粉丝数、`全平台24h` |
| `/hodlers/top` | 某币的 FOMO 持有人总数 + Top50（身份/粉丝/持仓量/盈亏） | `Fomo 336`、Top10 那一段 |

`/hodlers/top` 单项返回 `{ tokenAddress, networkId, totalHolders, topHolders[] }`，
每个持有人带 `user{evmAddress,userHandle,displayName,followers}`、`humanAmount`、`pnl`、
`costBasis`、`averageHoldTimeSeconds`、`isDev`。**`totalHolders` 就是「持有该币的 FOMO
用户数」**，也就是卡片上 `全链 491 · Fomo 336` 里的 Fomo——不用自己维护钱包↔身份映射表。

其他见过的端点：`/proxy/trendingTokens`、`/proxy/mostHeld`、`/proxy/tokenDetails`、
`/hodlers/devs`、`/hodlers/friends`、`/trades`、`/feed/token`、`/watchlist`、`/v2/users`。

### 抓取这半踩的坑

1. **headless 的 UA 里带 `HeadlessChrome`，接口直接拒。**
   返回 430/431 且**不带 CORS 头**，所以浏览器控制台报的是
   "blocked by CORS policy: No 'Access-Control-Allow-Origin' header"——极具误导性，
   看着像跨域配置问题，其实是反爬。覆盖成正常 Chrome UA 就通了：
   请求数从 6 次全败变成 40 次全成。

2. **别想拿 localStorage 里的 token 自己重放请求。**
   `privy:token` 的长度和浏览器实际发的 Authorization 完全对得上（413 字符），
   但直接调仍返回 `{"error":"unauthorized"}`——前端在内存里持有的是刷新过的那个。
   老老实实让页面自己发请求，我们只读响应。

3. **响应外壳不统一。**
   都是 `{ success, message, responseObject, statusCode }`，但 `/hodlers/top` 的
   `responseObject` 直接是数组，`/v2/leaderboard/24h` 却是 `{ leaderboard: [...] }`。
   剥完外壳还得再往里找一层数组。

4. **榜单只在应用冷启动时拉一次。**
   `/` 会被重定向到 `/token`，SPA 内部再导航不会重新拉；而且**前端路由表里根本
   没有 `/leaderboard`**。所以要在第一次启动导航**之前**就把等待挂上——
   曾经因为等待挂晚了，超时后 6ms 响应才到。

5. **名次没有字段。** 榜单靠数组顺序表示名次，下标 +1 才是 `#28` 那个数。
   地址要读 `evmAddress`（`address` 字段是 Solana 地址）。

6. **FOMO 自己的持币索引对新币有延迟。**
   实测某个币触发时 `totalHolders` 还是 0，21 秒后才变成 2；而同一时刻
   DEBT 是 710、CRIME 是 1114、MEME 是 11494——管线没问题，是上游在追。
   **这恰恰解释了原版为什么要有 `+5m1s 复核`**：初值那一刻 FOMO 侧往往还没数。
   所以复核时要强制刷新（`tokenStats(ca, 2000)`），别让 60 秒缓存把初值那份原样返回。

7. **用户主地址不是实际持币的交易账户。**
   `user.evmAddress` 与链上持币地址不同，直接相交会把 Top10 全部误报成 `0/10`。
   Top10 直接采用 `/hodlers/top` 的持仓排序。
   两位小数持仓与链上余额的唯一匹配**只能产生候选**，证明不了钱包归属——
   它会碰撞、会受两侧采样错位影响，一个用户还可能有多个钱包。
   候选存进 `fomo_wallet_links`（带证据类型/来源/链 ID/观测时间/验证状态），
   **只有拿到独立证据才升为 `confirmed`，也只有 `confirmed` 参与统计**。

8. **`/hodlers/top.pnl` 不是「全平台 24H 收益」。**
   它等于 `realizedPnl + unrealizedPnl`（50/50 复算通过），是**该币全时段累计**。
   同一用户同一时刻它可以与全平台 24H 收益反号（Binkieee：该币 −6,158 / 全平台24H +552,794）。
   把它求和标成「全平台24H PnL」是假标签。完整证据见 [docs/FIELDS.md](docs/FIELDS.md)。

## 用法

```bash
npm install
cp .env.example .env      # 填 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID
npm run dry-run           # 禁发送模式：不做任何 Telegram 网络调用，卡片进本地记录器
npm start                 # 同样默认禁发送；要真发消息需显式 NOTIFY_MODE=telegram
```

接社交数据（需要 FOMO 账号）：

```bash
npm run login           # 开有头浏览器，**在它打开的那个窗口里**登录
npm run check-session   # 体检：会话还有效吗
npm start
```

⚠️ `npm run login` 开的是一个**独立浏览器、独立 profile**，你日常 Chrome 里的
FOMO 登录状态不会带过来，必须在新窗口里重新登录一次。登录一次长期有效。

（Chrome 136+ 禁止对默认 profile 开远程调试端口，所以没法直接挂上你现在这个
已登录的 Chrome。）

联调与排查：

```bash
npm run dry-run        # 阈值放宽 + 2 分钟复核，验证整条链路
npm run status         # 当前库里的池 / 候选 / 健康指标
npm run explain        # 逐个候选打印被哪一道门卡住 —— 调阈值时最有用
npm run check-session  # FOMO 会话是否有效
npm run diagnose       # 抓一遍浏览器的导航轨迹 / 请求域名 / 接口响应 / 控制台报错
npm run discover       # 列出观察到的接口和各自能提取多少条记录
npm test               # enrichment / Top10 / 盈利榜账户映射回归测试
```

## 规则

全在 [config/rules.yaml](config/rules.yaml)，改完重启生效。

FOMO 那三条（`fomo_holders` / `fomo_holder_ratio` / `fomo_leaderboard_holders`）默认是 `0`，
即只展示不设门——按原版截图两条样本反推的结果，其中 HDR（Fomo 13 人 / 7.8% / 榜单 0 人）
被原版推送过，证明这三项在原版那里不构成门槛。`npm run backtest` 可以回测验证。

同一个扫描 tick 内触发的币共用同一个「首次触发」时间戳——原版截图里两个不同的币
时间戳精确到毫秒完全一致（`04:56:44.727`），说明它是按节拍扫候选集，不是逐事件流式触发。

判定分两道门：先过链上量价（免费，只查本地库），过了才去查币龄和拉持币快照。
**第二道门拒绝时要单独给一个短冷却**——否则删掉占位告警记录后 dedup 就失效了，
下个 tick 又触发、又被拒，实测某个币 30 秒内空转 9 次、每次白扫一遍持币表。
但也不能直接套 6 小时的正常冷却：第 1 分钟持币人不够、第 10 分钟够了的币应该还有机会。
持币表和 FOMO 代币页没预热完不会触发——否则「+0.8s 快照」实际要等几十秒，
同一行的全链与 FOMO 数据也不是同一采样时刻。
预热**失败**（比如 Blockscout 限流查不到部署区块）必须允许重试，不能一次失败就把币
永久拉黑——那样它既不 warm 也不再重试，等于永远触发不了。

卡片里的 `(+0.8s)` / `(+5m1s)` 渲染的是**实测耗时**，不是配置里的标称值。
复核是睡到「触发时刻 + 复核延迟」这个绝对时间点，不是睡固定时长——初值快照和发消息
本身要花几秒，睡固定时长会让复核时刻一路往后漂（实测配置 25s、实际落在 32.6s）。

## 结构

```
src/
  chain/      abi client blockscout quotes pricing holders volume watcher backfill marketdata
  fomo/       session login scraper extract provider
  engine/     触发判定 + 快照调度 + 社交聚合 + 持久化复核
  notify/     卡片渲染 + Telegram 收发
scripts/      probe-* 是当初逐项核实链上事实用的探针，留着方便复查
```

## 注意

抓取 `prod-api` 属于绕过 FOMO 客户端的访问限制。自用监控通常没问题，
但别公开分发抓取结果、别高频打他们的接口。
