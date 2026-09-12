# 本轮整改交付物索引

## 新策略 post_v1

| 交付物 | 位置 |
|---|---|
| 设计与验收契约 | [design/POST_STRATEGY_TG_IMPLEMENTATION.md](design/POST_STRATEGY_TG_IMPLEMENTATION.md) |
| **当前实现进度（先看这个）** | [run/POST_PROGRESS.md](run/POST_PROGRESS.md) |
| 阶段 0 依赖核验报告（实测） | [run/POST_DEPENDENCIES.md](run/POST_DEPENDENCIES.md) |
| 实现代码 | `src/post/`、`src/notify/post-render.ts`、`src/notify/post-telegram.ts` |
| 配置 | `config/post-strategy.yaml` |
| 测试 | `tests/post-*.test.ts`（254 项） |
| 回放 fixture（**合成**，非实测行情） | `docs/run/fixtures/second-leg-synthetic.json` |
| 一次回放报告 | `run/evidence/post-replay-second-leg.json` |

状态摘要：主链路（链上候选 → 可解释信号 → 可靠通知出口）已打通并在 `NOTIFY_MODE=off` 下跑通；
**二段尚未实盘验收**（需要第一波 + 至少 48h 箱体，真实数据还在积累）；
自动叙事 provider 与 DeBot adapter 未接入，均为显式 `available=false` 的 stub。
详见 [run/POST_PROGRESS.md](run/POST_PROGRESS.md) 的「还没做到的」一节。

```bash
npm run post:check-config   # 配置校验 + configHash
npm run post:probe          # 只读依赖探针
npm run post:dry-run        # STRATEGY_MODE=post_v1 NOTIFY_MODE=off 实跑
npm run post:explain -- --chain 4663 --ca 0x…
npm run post:replay -- --fixture docs/run/fixtures/second-leg-synthetic.json --output /tmp/replay
npm run post:report -- --hours 24
```

## 既有整改交付物

| 交付物 | 位置 |
|---|---|
| 1. 修改后的代码 | `src/` |
| 1. 可重复运行的自动化测试 | `tests/`（363 项，`npm test`：旧 109 + post_v1 254）|
| 2. 数据字段口径与证据 | [FIELDS.md](FIELDS.md) |
| 3. 数据库迁移、旧推断映射隔离与恢复说明 | [MIGRATION.md](MIGRATION.md) |
| 4. 60 分钟验收报告 | [run/ACCEPTANCE.md](run/ACCEPTANCE.md) |
| 5. 更新后的交接文档 | [../HANDOFF.md](../HANDOFF.md)（§8 逐条纠正历史结论）|

## 原始证据

| 文件 | 内容 |
|---|---|
| `evidence/hodlers-top-sample.json` | `/hodlers/top` 单个代币的完整条目（50 个持有人）|
| `evidence/endpoints.json` | 一次代币页访问命中的全部端点与失败响应 |
| `evidence/user-pnl-endpoints.json` | 用户档案页触发的端点清单 |
| `evidence/user-balances-cosby.json` | `/v2/users/:id/balances`、`/swaps`、`aggregatedSnapshot` 原始结构 |
| `evidence/snapshot-pnl-probe.json` | 按 userId 查任意用户整点快照的结果 |
| `evidence/agg-series.json` | `aggregatedSnapshot` 逐小时序列与入参形态 |
| `evidence/verify-24h.json` | 用序列复算 24H 收益、与榜单对照（含负收益样本）|
| `run/evidence/samples.json` | 实跑样本：分阶段时间戳、Top10 原始行、通知记录、复算依据 |
| `run/dryrun.log` | 验收跑的完整日志 |
| `data/backups/fomot-*.db` | 一致性备份（`VACUUM INTO`，含 WAL 内容，`integrity_check = ok`）|

所有证据文件都经过凭据扫描（`authorization` / `bearer` / `privy` / `cookie` / `jwt` / `eyJ`），**零命中**。

## 复现命令

```bash
npm run typecheck          # tsc --noEmit
npm test                   # 109 项，独立临时库，不碰 data/fomot.db
npm run check-rules        # 规则文件解析
npm run backtest           # 拿原版截图两条样本回测
npm run dry-run            # 禁发送模式实跑（生产规则）
npm run dry-run:relaxed    # 禁发送模式实跑（放宽规则，结果需单独标注）
npm run report 60          # 最近 60 分钟的指标分位数与告警明细
npx tsx scripts/crash-recovery-drill.ts   # 隔离环境的 SIGKILL 恢复演练
```

## 探针脚本（用户已有登录态，只读，不写凭据）

| 脚本 | 作用 |
|---|---|
| `scripts/probe-pnl-semantics.ts` | `/hodlers/top` 的 pnl 家族字段语义 |
| `scripts/probe-user-pnl.ts` | 用户档案页会触发哪些端点 |
| `scripts/probe-user-balances.ts` | `/v2/users/:id/balances` 的完整结构 |
| `scripts/probe-snapshot-pnl.ts` | 按 userId 查任意用户的整点快照 |
| `scripts/probe-agg-series.ts` | `aggregatedSnapshot` 序列与边界 |
| `scripts/probe-verify-24h.ts` | 用序列复算 24H 收益并与榜单对照 |
| `scripts/probe-recipient.ts` | 判定 `swaps.recipient` 是用户账户还是中继归集地址 |
