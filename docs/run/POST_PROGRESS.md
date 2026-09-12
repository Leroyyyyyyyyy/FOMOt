# post_v1 实现进度

最后更新：2026-09-12
基线：`19ed299`（本轮之前）
实现依据：[docs/design/POST_STRATEGY_TG_IMPLEMENTATION.md](../design/POST_STRATEGY_TG_IMPLEMENTATION.md)

## 一句话结论

**链上候选 → 可解释信号 → 可靠通知出口这条主链路已经打通并跑通**（`NOTIFY_MODE=off`）。
A/B/C/RSI、失效、重启、去重、未知数据、无前视都有验证证据。
**二段策略尚未实盘验收**——它需要第一波 + 至少 48h 箱体，当前用的是本地积累模式，
真实数据还在攒；仓库里通过的二段用例跑的是**标注为合成的 fixture**，不是实测行情。

## 分阶段状态（设计文档 §13）

| 阶段 | 状态 | 证据 |
|---|---|---|
| 0 确认现状和依赖 | ✅ 完成 | [POST_DEPENDENCIES.md](POST_DEPENDENCIES.md)（`npm run post:probe` 实测） |
| 1 数据底座与隔离 | ✅ 完成 | `src/post/store.ts`、`src/post/market/*`、`tests/post-store.test.ts`、`tests/post-market.test.ts` |
| 2 确定性形态 + 人工叙事 | ✅ 完成 | `src/post/patterns/*`、`src/post/narrative.ts`、`npm run post:explain` |
| 3 TG 和恢复 | ✅ 完成 | `src/post/outbox.ts`、`src/notify/post-render.ts`、`tests/post-outbox.test.ts`、`tests/post-e2e.test.ts` |
| 4 可选自动化来源 | ⛔ 未接入（按设计文档，stub 不计为已完成） | `src/post/providers/debot.ts`、`manual.ts` 均显式 `available=false` 并给出原因 |
| 5 回放与持续验收 | 🟡 工具已交付，长周期观察未完成 | `npm run post:replay`（无前视断言通过）、`npm run post:report` |

## 已经做到的

- **配置隔离**：`config/post-strategy.yaml` 独立于 `config/rules.yaml`；未知 key 报错、
  跨字段约束（48<96、保留窗口必须覆盖 `ready_max_hours`、`volume_usd` 必须显式给窗口、
  关掉叙事硬门必须把 version 标 `experimental`）。`configHash` 进每条信号与 episode。
- **与旧表彻底隔离**：post 自带一套 `post_*` 表，**完全不读**旧 `pools`/`swaps`/`pool_state`。
  测试直接调用旧 `pruneAll()` 断言 post 侧数据一根不少——这是二段能横 2–4 天的前提。
- **口径**：报价只取事件时点之前且当时已可用的那条，滞后 >120s 即 `missing`；
  USDG=$1 记 `peg_proxy`；历史 FDV 只用当时的供应量快照，证明不了就是 `null`；
  成交额只算 quote 侧一边。
- **K 线**：1m 只由真实成交聚合，5m/15m/1h 只由完整 1m 聚合（缺一根父桶即 `unknown`）；
  扫描完整的空桶才是 `synthetic` 平线，有缺口一律 `unknown` 且价格为 `null`。
- **区块时间**：不用 `BlockClock.tsOf` 的长时间线性外推。改成每 300 块取一次真实区块头、
  只在相邻已测锚点之间按实测间隔插值，落在分钟边界误差带内的区块补精确取值；
  近似在数据里可见（K 线 `source=chain:anchored300`）。
- **形态**：pivot 的 `extremeTs` 与 `confirmedAt` 严格分开；二段/新币/百万/RSI 都是纯函数，
  有界窗口内完整重算，保证回放与实时严格同构。
- **叙事**：程序验 schema/来源/时间/CA 绑定，模型只给候选判断；CA 冲突不可被任何总分抵消；
  网页与代币名字按不可信数据处理（`escapeHtml` + `safeUrl` 阻断内网与云元数据端点）。
- **通知**：结构化发送结果（`delivered` / `definiteFailure` / `ambiguous`），持久 outbox
  带 lease / deadline / revision 校验；`ambiguous` 的新建主卡不自动重发，进人工核对清单。
- **无前视**：`loadCandles` 的 `asOf` 截断 + `post:replay` 的逐桶对照断言。

## 还没做到的（不要当成已完成）

1. **二段实盘样本为 0**。仓库里二段的成功路径用例跑的是 `docs/run/fixtures/second-leg-synthetic.json`
   （文件里 `note: "synthetic"`）。要拿到实测样本，要么开 `history.startup_mode=backfill`
   跑一次 7 天回补（阶段 0 已核验两个 RPC 端点 7 天前的日志可读），要么让 accumulate
   模式连续跑 3–4 天。**在那之前不能说二段已经验证。**
2. **自动叙事 provider 未接入**。当前只有人工导入（`npm run post:import`）。
   接入前要先列出可用搜索/社媒数据源与费用限制，并补 `POST_DEPENDENCIES.md`。
3. **DeBot adapter 未启用**。只查到功能教程，没核验到可复用的开发者接口契约——
   这不等于确认 DeBot 没有 API，只是我们还没验过。
4. **`volume_usd` 口径未做对照实验**。设计文档要求上线报告至少比较 `fdv_proxy` 与 `off`；
   目前默认 `fdv_proxy`，另两种模式代码可用但还没跑对照。
5. **容量数字是目标不是结果**。200 hot / 1000 warm 是预算配置；实跑只到 hot 2 / warm 19。
6. **没有任何收益结论**。`post:report` 刻意只报形态识别与通知链路。
7. **本轮未发送过任何真实 Telegram 消息**。全部演练在 `NOTIFY_MODE=off` 下完成
   （`post-probe` 只调过 `getMe`）。

## 实跑记录

| 时间 | 内容 | 结果 |
|---|---|---|
| 2026-09-12 | `npm run post:probe` | 两个 RPC 端点 7 天前日志可读；实测出块 101.1ms/块；Swap ~6 条/块；Blockscout stats 返回 HTML（三路报价剩 2 路） |
| 2026-09-12 | `npm run post:dry-run` 150s（独立临时库） | 池/代币/成交/报价/供应量/覆盖/K 线/evaluation 全部落库；K 线出现 complete / synthetic / partial / unknown 四种状态；未产生任何信号（符合预期：新发现的币还没有 5 根真实 1m K） |
| 2026-09-12 | `npm run post:replay`（合成 fixture） | 二段 READY 在 48h 处确认；无前视检查通过；`NOTIFY_MODE=telegram` 被内部强制成 `off` |
| 2026-09-12 | `npm test` | 363 项通过（旧 109 + 新 254） |

## 复现命令

```bash
npm run post:check-config                      # 配置校验 + configHash
npm run post:probe                             # 只读依赖探针，重写 POST_DEPENDENCIES.md
npm test                                       # 363 项，独立临时库
npm run post:dry-run                           # STRATEGY_MODE=post_v1 NOTIFY_MODE=off 实跑
npm run post:explain -- --chain 4663 --ca 0x…  # 逐条规则解释「为什么没推」
npm run post:import -- --file <validated.json> # 人工导入叙事 / 题材 / CA / 持仓参考价
npm run post:replay -- --fixture docs/run/fixtures/second-leg-synthetic.json --output /tmp/replay
npm run post:report -- --hours 24              # 运行报告（不含收益结论）
```

进生产通知需要显式两步：`.env` 配好 Telegram 凭据 **且** 运行时设
`STRATEGY_MODE=post_v1 NOTIFY_MODE=telegram`。缺任一项都退回禁发送模式。

## 下一步建议顺序

1. 开 `backfill` 跑一次 7 天回补，或让 accumulate 连跑 3–4 天，拿到第一批真实二段样本。
2. 用真实样本跑 `post:replay`，并按 §14.1 出一份分组报告（A/B/C × 题材重复 × size_band 模式）。
3. 再做 `fdv_proxy` vs `off` 的对照，有完整量数据后补 `volume_usd`（窗口必须显式声明）。
4. 阶段 4 的自动叙事与 DeBot 单独立项、单独验收。
