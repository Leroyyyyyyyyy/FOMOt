# 数据库迁移、旧推断映射隔离与恢复说明

## 0. 先备份，再迁移

运行中的 `.db` 不能直接复制——WAL 里的已提交事务会漏掉。用 SQLite 自己的一致性快照：

```bash
sqlite3 data/fomot.db "VACUUM INTO 'data/backups/fomot-$(date +%Y%m%d-%H%M%S).db'"
```

`VACUUM INTO` 在一个读事务里完成，产出的文件已包含 WAL 中的内容，且自带 `integrity_check` 可验证：

```bash
sqlite3 data/backups/<file>.db "PRAGMA integrity_check;"
```

本轮整改前的基线备份：`data/backups/fomot-20260905-190501.db`（69,849,088 字节，integrity_check = ok）。
**没有删除任何历史数据**——包括旧的 `fomo_trade_wallets` 表，它原样保留。

## 1. 迁移内容（启动时幂等执行）

迁移由 `src/db.ts` 在进程启动时跑，用 `cursor` 表里的 `migrate_wallet_links_v1` 做幂等标记，重复启动不会重复迁移。

### 新增表

| 表 | 用途 |
|---|---|
| `notification_log` | 通知出口的本地记录器。禁发送模式下所有 send/edit/remove 都只落这里 |
| `fomo_wallet_links` | 钱包 ↔ 身份映射的**证据链**，取代裸映射 |
| `run_metrics` | 实跑指标采样，验收报告的 P50/P95/最大值由它算出 |

### 新增列

| 表 | 列 | 用途 |
|---|---|---|
| `alerts` | `collection_state` | `pending` / `complete` / `degraded`——与 `status` 分开 |
| `alerts` | `original_due_ts` | **原定**到期时间，重试永不覆盖它 |
| `alerts` | `attempts` | 复核尝试次数 |
| `alerts` | `firing_ts` | 识别异常退出遗留的 firing |
| `alerts` | `notify_mode` | 发这张卡时的通知模式 |
| `fomo_token_stats` | `resp_ts` | FOMO **响应到达**时间，与入库提交时间 `updated_ts` 分开 |

### `alerts.status` 取值

| 值 | 含义 |
|---|---|
| `firing` | 正在走触发流程；异常退出会留下这个状态 |
| `pending_recheck` | 卡片已发出，等待复核 |
| `completed` | 复核完成（配合 `collection_state` 判断数据是否齐全）|
| `abandoned` | 终结为降级：payload 损坏、超出重试期限、或崩溃窗口遗留 |

`abandoned` 的记录**不参与**去重冷却（`recentAlert` 已排除），所以一次降级不会把这个币拉黑 6 小时。

## 2. 旧推断映射的隔离

`fomo_trade_wallets` 里的 437 条记录全部来自「两位小数持仓唯一相同」的金额推断。
这**不构成归属证明**：两位小数会碰撞、两侧快照存在采样错位、一个用户可能有多个钱包，
地址带 EIP-7702 委托代码也不证明它属于某个 FOMO 用户。

迁移策略：

```
fomo_trade_wallets (437 行，原样保留)
        │
        └──► fomo_wallet_links
             status        = 'candidate'      ← 全部是候选，没有一条自动升为 confirmed
             evidence_type = 'amount_match_legacy'
             evidence_src  = 'fomo_trade_wallets 迁移'
             note          = '两位小数持仓唯一匹配，未经独立证据验证'
```

实跑启动日志确认：

```
历史金额推断映射已迁移为未验证候选   迁移条数: 437
钱包映射状态   candidate: 437  confirmed: 0  conflict: 0  revoked: 0
```

**聚合统计只读 `status='confirmed'`**（`confirmedWallets()`），所以这 437 条候选
一条都不会进入榜单交集或身份覆盖率。这一点由 `tests/wallets.test.ts` 与
`tests/enrich.test.ts`（「只有已确认的钱包映射才参与榜单交集」）锁住。

### 状态机

| status | 何时进入 | 是否参与统计 |
|---|---|---|
| `candidate` | 金额匹配（含历史迁移） | **否** |
| `confirmed` | `confirmLink()`，需要 `transfer_trace` / `api_declared` 等独立证据 | 是 |
| `conflict` | 同一地址被两个 userId 命中 → 两边一起隔离 | **否** |
| `revoked` | `revokeLink()` 人工撤销，历史行保留 | **否** |

冲突和撤销都只改状态、不删行，随时可以回查。

### 升级为已确认需要什么

`confirmLink()` 要求写明 `evidence_type` / `evidence_src`，并可带 `tx_hash` + `log_index` + `token_ca` + `chain_id`。
目前**尚未**接入自动的链上溯源器，所以 `confirmed` 计数为 0——这是如实的降级，
不是遗漏。接口和存储已就位，接入溯源后即可逐条升级。

注意 `/hodlers/top` 里 `recipient` 类字段可能是中转账户，升级前必须核对最终 Transfer、
网络和代币，这一点写在 `src/engine/wallets.ts` 的文档注释里。

## 3. 回滚

迁移只增表增列，不改写也不删除既有数据，所以回滚就是换回备份文件：

```bash
# 1. 停进程
pkill -f "tsx src/index.ts"
# 2. 换回备份（连同 WAL 一起清掉）
rm -f data/fomot.db data/fomot.db-wal data/fomot.db-shm
cp data/backups/fomot-20260905-190501.db data/fomot.db
```

只想重跑钱包迁移（不回滚整库）：

```bash
sqlite3 data/fomot.db "DELETE FROM cursor WHERE k='migrate_wallet_links_v1'; DELETE FROM fomo_wallet_links WHERE evidence_type='amount_match_legacy';"
```

## 4. 崩溃恢复

启动时 `Engine.resumePending()` 处理四类遗留，返回 `{resumed, orphanFiring, corrupt}`：

| 情况 | 处理 |
|---|---|
| `pending_recheck` + payload 完好 | 恢复复核任务；`original_due_ts` 与 `recheck_due_ts` 分别还原 |
| `firing` + **有**成功的 `notification_log` send 记录 | 卡片确实发出去了（发送成功、状态未落库的崩溃窗口）→ 标 `abandoned`/`degraded`，**不删** |
| `firing` + 无发送记录 | 卡片从未发出 → 删掉占位行，不让 dedup 拉黑这个币 |
| payload 损坏 / 缺失 | 标 `abandoned`/`degraded`，记 `last_error`，不崩溃、不当成完成 |

重复调用 `resumePending()` 是幂等的（内存里的 `resumed` 集合去重）。
以上七种情形都有测试：`tests/recovery.test.ts`。

## 5. 测试隔离

测试**绝不**读写 `data/fomot.db`。`FOMOT_DB` 环境变量指定库路径，
`tests/helpers/tmpdb.ts` 在任何 `src/db.js` 之前被 import，把它指向一个临时目录，
同时强制 `NOTIFY_MODE=off`。已实测：跑完全套测试后 `data/fomot.db` 的 mtime 不变。
