import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 库路径可配。测试**必须**用独立临时库，绝不能读写日常运行的 data/fomot.db。
 * `FOMOT_DB` 支持绝对路径，也支持 ':memory:'。
 */
const dbPath = process.env.FOMOT_DB
  ? (process.env.FOMOT_DB === ':memory:' ? ':memory:' : resolve(process.env.FOMOT_DB))
  : new URL('../data/fomot.db', import.meta.url).pathname;
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

export const dbFile = dbPath;
export const db = new DatabaseSync(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

-- 链上发现的 V4 池
CREATE TABLE IF NOT EXISTS pools (
  pool_id     TEXT PRIMARY KEY,
  ca          TEXT NOT NULL,
  quote       TEXT NOT NULL,          -- 计价资产（原生币为 0x0）
  token_is0   INTEGER NOT NULL,       -- 目标代币是否为 currency0
  fee         INTEGER,
  hooks       TEXT,
  init_block  INTEGER NOT NULL,
  init_ts     INTEGER NOT NULL        -- 毫秒
);
CREATE INDEX IF NOT EXISTS idx_pools_ca   ON pools(ca);
CREATE INDEX IF NOT EXISTS idx_pools_init ON pools(init_ts);

-- 代币元数据（RPC + Blockscout 混合来源）
CREATE TABLE IF NOT EXISTS tokens (
  ca           TEXT PRIMARY KEY,
  symbol       TEXT,
  name         TEXT,
  decimals     INTEGER,
  total_supply TEXT,
  updated_ts   INTEGER
);

-- Swap 明细，用于滚动窗口成交量。定期裁剪。
CREATE TABLE IF NOT EXISTS swaps (
  pool_id  TEXT NOT NULL,
  block    INTEGER NOT NULL,
  log_idx  INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  usd      REAL NOT NULL,
  PRIMARY KEY (pool_id, block, log_idx)
);
CREATE INDEX IF NOT EXISTS idx_swaps_ts ON swaps(pool_id, ts);
-- 单独的 ts 索引：activeTokens 每秒跑一次，用 (pool_id, ts) 复合索引服务不了
-- 裸的 s.ts >= ? 条件，SQLite 只能从 pools 侧驱动、逐池探测 swaps。
-- pools 无上限增长（约 5-7 个新池/分钟），那个热查询就会随运行时长线性变慢。
CREATE INDEX IF NOT EXISTS idx_swaps_ts_only ON swaps(ts);

-- 持币快照：stage = 'initial'(+0.8s) | 'recheck'(+5m1s)
CREATE TABLE IF NOT EXISTS holder_snapshots (
  ca            TEXT NOT NULL,
  trigger_ts    INTEGER NOT NULL,
  stage         TEXT NOT NULL,
  taken_ts      INTEGER NOT NULL,
  total_holders INTEGER,
  fomo_holders  INTEGER,
  payload       TEXT,
  PRIMARY KEY (ca, trigger_ts, stage)
);

-- 已推送的告警（去重 + 后续编辑消息用）
CREATE TABLE IF NOT EXISTS alerts (
  ca          TEXT NOT NULL,
  trigger_ts  INTEGER NOT NULL,
  message_id  INTEGER,
  payload     TEXT,
  status      TEXT NOT NULL DEFAULT 'completed',
  recheck_due_ts INTEGER,
  last_error  TEXT,
  PRIMARY KEY (ca, trigger_ts)
);
CREATE INDEX IF NOT EXISTS idx_alerts_ca ON alerts(ca, trigger_ts DESC);

-- 钱包 ↔ FOMO 身份映射。原版「持币覆盖 49/336」量的就是这张表的覆盖率。
CREATE TABLE IF NOT EXISTS fomo_identities (
  address    TEXT PRIMARY KEY,
  user_id    TEXT,
  handle     TEXT,
  followers  INTEGER,
  updated_ts INTEGER
);

-- FOMO 的 evmAddress 是用户主地址，代币通常实际记在另一个 7702 交易账户。
-- 通过 /hodlers/top 的两位小数持仓与链上余额唯一对应后，持久化这个映射。
CREATE TABLE IF NOT EXISTS fomo_trade_wallets (
  user_id    TEXT NOT NULL,
  address    TEXT NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, address)
);
CREATE INDEX IF NOT EXISTS idx_ftw_address ON fomo_trade_wallets(address);

-- 24H 盈利榜
CREATE TABLE IF NOT EXISTS fomo_leaderboard (
  user_id    TEXT PRIMARY KEY,
  rank       INTEGER,
  handle     TEXT,
  address    TEXT,
  followers  INTEGER,
  pnl_24h    REAL,
  updated_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lb_rank ON fomo_leaderboard(rank);

-- 某代币的 FOMO 侧统计。totalHolders 是「持有该币的 FOMO 用户数」，
-- 也就是卡片上「全链 491 · Fomo 336」里的 Fomo 那个数。
CREATE TABLE IF NOT EXISTS fomo_token_stats (
  ca           TEXT PRIMARY KEY,
  fomo_holders INTEGER,
  updated_ts   INTEGER,
  ingest_ms    INTEGER
);

-- 某代币的 FOMO Top 持有人（/hodlers/top）
CREATE TABLE IF NOT EXISTS fomo_token_holders (
  ca          TEXT NOT NULL,
  rank        INTEGER NOT NULL,
  user_id     TEXT,
  handle      TEXT,
  evm_address TEXT,
  followers   INTEGER,
  amount      REAL,
  pnl         REAL,
  is_dev      INTEGER,
  updated_ts  INTEGER,
  PRIMARY KEY (ca, rank)
);
CREATE INDEX IF NOT EXISTS idx_fth_user ON fomo_token_holders(user_id);

-- 健康指标（对应卡片最后一行）
CREATE TABLE IF NOT EXISTS health (
  metric TEXT PRIMARY KEY,
  value  TEXT,
  ts     INTEGER
);

-- 每个池的最新价（来自最后一条 Swap 的 sqrtPriceX96），用于实时算市值
CREATE TABLE IF NOT EXISTS pool_state (
  pool_id TEXT PRIMARY KEY,
  sqrt    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  has_swap INTEGER NOT NULL DEFAULT 0
);

-- 代币部署区块。这是永不改变的事实，值得持久化：
-- Blockscout 的 v1 creation 接口会返回 429，v2 addresses 接口实测会挂死约 50 秒，
-- 而这一步在 +0.8s 快照的关键路径上。存下来就只用查一次。
CREATE TABLE IF NOT EXISTS token_deployment (
  ca         TEXT PRIMARY KEY,
  block      INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);

-- 扫描游标
CREATE TABLE IF NOT EXISTS cursor (k TEXT PRIMARY KEY, v TEXT);

-- 通知出口的本地记录器。禁发送模式下所有发送/改写/撤回都只落在这里。
CREATE TABLE IF NOT EXISTS notification_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  mode       TEXT NOT NULL,          -- off | telegram
  op         TEXT NOT NULL,          -- send | edit | remove
  message_id INTEGER,
  ca         TEXT,
  trigger_ts INTEGER,
  ok         INTEGER NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_ts ON notification_log(ts);
CREATE INDEX IF NOT EXISTS idx_notif_alert ON notification_log(ca, trigger_ts);

-- 实跑指标采样。验收报告的 P50/P95/最大值就是从这张表算出来的。
CREATE TABLE IF NOT EXISTS run_metrics (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,
  name  TEXT NOT NULL,
  value REAL NOT NULL,
  phase TEXT NOT NULL,        -- startup | steady
  note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON run_metrics(name, ts);

-- 钱包 ↔ FOMO 身份映射的**证据链**。
--
-- 取代 fomo_trade_wallets 的裸映射：金额匹配只能产生候选（status='candidate'），
-- 只有拿到独立证据（链上 Transfer 溯源等）才能升到 'confirmed'。
-- 冲突映射标 'conflict' 并从统计里排除，撤销则标 'revoked'。
CREATE TABLE IF NOT EXISTS fomo_wallet_links (
  user_id       TEXT NOT NULL,
  address       TEXT NOT NULL,
  chain_id      INTEGER NOT NULL,
  status        TEXT NOT NULL,        -- candidate | confirmed | conflict | revoked
  evidence_type TEXT NOT NULL,        -- amount_match_legacy | amount_match | transfer_trace | api_declared
  evidence_src  TEXT,                 -- 端点 / 脚本 / 说明
  observed_ts   INTEGER NOT NULL,     -- 证据观测时间
  verified_ts   INTEGER,              -- 升为 confirmed 的时间
  tx_hash       TEXT,                 -- 链上证据的交易哈希
  log_index     INTEGER,              -- 该交易内的日志位置
  token_ca      TEXT,                 -- 产生该证据的代币
  note          TEXT,
  PRIMARY KEY (user_id, address, chain_id)
);
CREATE INDEX IF NOT EXISTS idx_fwl_address ON fomo_wallet_links(address);
CREATE INDEX IF NOT EXISTS idx_fwl_status  ON fomo_wallet_links(status);
`);

/** SQLite 的 CREATE TABLE IF NOT EXISTS 不会给旧库补列，启动时做小型幂等迁移。 */
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('alerts', 'status', "status TEXT NOT NULL DEFAULT 'completed'");
ensureColumn('alerts', 'recheck_due_ts', 'recheck_due_ts INTEGER');
ensureColumn('alerts', 'last_error', 'last_error TEXT');
ensureColumn('fomo_token_stats', 'ingest_ms', 'ingest_ms INTEGER');
// FOMO 响应到达时间与入库提交时间分开存，别把它们揉成一个 updated_ts
ensureColumn('fomo_token_stats', 'resp_ts', 'resp_ts INTEGER');
ensureColumn('pool_state', 'has_swap', 'has_swap INTEGER NOT NULL DEFAULT 0');
// 复核生命周期：把「是否通过筛选规则」与「采集是否完成」分开记录。
ensureColumn('alerts', 'collection_state', "collection_state TEXT");      // complete | degraded | pending
ensureColumn('alerts', 'original_due_ts', 'original_due_ts INTEGER');     // 初始到期时间，重试不覆盖
ensureColumn('alerts', 'attempts', 'attempts INTEGER NOT NULL DEFAULT 0');
ensureColumn('alerts', 'firing_ts', 'firing_ts INTEGER');                 // 识别异常退出遗留的 firing
ensureColumn('alerts', 'notify_mode', 'notify_mode TEXT');                // 发这张卡时的通知模式
db.exec('UPDATE pool_state SET has_swap = 1 WHERE has_swap = 0 AND pool_id IN (SELECT DISTINCT pool_id FROM swaps)');

/**
 * 迁移：历史 fomo_trade_wallets 全部是「持仓金额唯一相同」推断出来的，
 * 它证明不了钱包归属。旧表**原样保留**（不删历史数据），但一律以
 * status='candidate' 落入 fomo_wallet_links，不会自动升级为可信映射。
 */
export const LEGACY_WALLET_EVIDENCE = 'amount_match_legacy';
function migrateLegacyWallets(): number {
  const done = db.prepare("SELECT v FROM cursor WHERE k='migrate_wallet_links_v1'").get() as { v: string } | undefined;
  if (done) return 0;
  const rows = db.prepare('SELECT user_id, address, updated_ts FROM fomo_trade_wallets').all() as
    { user_id: string; address: string; updated_ts: number }[];
  const ins = db.prepare(
    `INSERT INTO fomo_wallet_links (user_id, address, chain_id, status, evidence_type, evidence_src, observed_ts, note)
     VALUES (?,?,?,'candidate',?,'fomo_trade_wallets 迁移',?,'两位小数持仓唯一匹配，未经独立证据验证')
     ON CONFLICT(user_id,address,chain_id) DO NOTHING`,
  );
  db.exec('BEGIN');
  try {
    for (const r of rows) ins.run(r.user_id, r.address.toLowerCase(), CHAIN_ID, LEGACY_WALLET_EVIDENCE, r.updated_ts);
    db.prepare("INSERT INTO cursor (k,v) VALUES ('migrate_wallet_links_v1', ?)").run(String(Date.now()));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return rows.length;
}
const CHAIN_ID = 4663;
export const migratedWalletCandidates = migrateLegacyWallets();

export function getCursor(k: string): string | null {
  const row = db.prepare('SELECT v FROM cursor WHERE k = ?').get(k) as { v: string } | undefined;
  return row?.v ?? null;
}
export function setCursor(k: string, v: string): void {
  db.prepare('INSERT INTO cursor (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

export function setHealth(metric: string, value: string | number): void {
  db.prepare(
    'INSERT INTO health (metric, value, ts) VALUES (?, ?, ?) ON CONFLICT(metric) DO UPDATE SET value = excluded.value, ts = excluded.ts',
  ).run(metric, String(value), Date.now());
}
/**
 * 指标采样。启动恢复期与稳态要分开统计——重启后 RPC 压力大、队列深，
 * 把两段混在一起算 P95 会同时高估稳态、低估恢复期。
 */
const insertMetric = db.prepare('INSERT INTO run_metrics (ts, name, value, phase, note) VALUES (?,?,?,?,?)');
let startupUntil = Date.now() + 120_000;
export function markStartupWindow(ms: number): void { startupUntil = Date.now() + ms; }
export function recordMetric(name: string, value: number, note?: string): void {
  if (!Number.isFinite(value)) return;
  try { insertMetric.run(Date.now(), name, value, Date.now() < startupUntil ? 'startup' : 'steady', note ?? null); }
  catch { /* 指标采样不能拖垮主流程 */ }
}

export function getHealth(metric: string): { value: string; ts: number } | null {
  return (db.prepare('SELECT value, ts FROM health WHERE metric = ?').get(metric) as any) ?? null;
}

/**
 * 清理所有会长的表。以前只清 swaps 一张，其余 8 张全是只进不出——
 * 这个进程是要连着跑几周的。
 *
 * 保留窗口按用途定：swaps 只服务 1h 窗口；pools/tokens 只要覆盖候选币龄窗口
 * （默认 180 分钟）就够，留 24 小时是宽裕的余量；FOMO 侧数据每次用都会刷新。
 */
export function pruneAll(): void {
  const now = Date.now();
  const H = 3600_000;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM swaps WHERE ts < ?').run(now - 2 * H);
    // 池子删了它的 pool_state 和 swaps 就成了孤儿，一起清
    db.prepare('DELETE FROM pool_state WHERE pool_id IN (SELECT pool_id FROM pools WHERE init_ts < ?)').run(now - 24 * H);
    db.prepare('DELETE FROM swaps    WHERE pool_id IN (SELECT pool_id FROM pools WHERE init_ts < ?)').run(now - 24 * H);
    db.prepare('DELETE FROM pools WHERE init_ts < ?').run(now - 24 * H);
    db.prepare('DELETE FROM tokens WHERE ca NOT IN (SELECT ca FROM pools)').run();
    db.prepare('DELETE FROM alerts WHERE trigger_ts < ?').run(now - 7 * 24 * H);
    db.prepare('DELETE FROM holder_snapshots WHERE trigger_ts < ?').run(now - 7 * 24 * H);
    db.prepare('DELETE FROM fomo_identities   WHERE updated_ts < ?').run(now - 24 * H);
    db.prepare('DELETE FROM fomo_trade_wallets WHERE updated_ts < ?').run(now - 30 * 24 * H);
    db.prepare('DELETE FROM notification_log WHERE ts < ?').run(now - 7 * 24 * H);
    db.prepare('DELETE FROM run_metrics WHERE ts < ?').run(now - 7 * 24 * H);
    // 候选映射会过期；已确认的映射有独立证据，不按时间清理。
    db.prepare("DELETE FROM fomo_wallet_links WHERE status='candidate' AND observed_ts < ?").run(now - 30 * 24 * H);
    db.prepare('DELETE FROM fomo_token_stats  WHERE updated_ts < ?').run(now - 24 * H);
    db.prepare('DELETE FROM fomo_token_holders WHERE updated_ts < ?').run(now - 24 * H);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** @deprecated 用 pruneAll。留着是因为 watcher 里还在按老节奏调。 */
export const pruneSwaps = pruneAll;
