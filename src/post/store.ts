/**
 * post_v1 的持久化底座（设计文档 §10）。
 *
 * **与旧表的隔离方式**：设计文档给了两个选项，这里选「post 侧自带一套表，
 * 只读自己的表」。理由是 `pruneSwaps` 其实是 `pruneAll` 的别名，watcher 每 5 分钟
 * 也会调一次，只改主入口的维护周期仍会把 24h 前的 `pools` 删掉；只要 post 还
 * 读旧表，就永远存在「某条清理路径没加保护」的风险。post 完全不读
 * pools/swaps/pool_state/tokens，旧清理再怎么跑都碰不到二段需要的历史。
 *
 * 所有时间是 UTC epoch 毫秒。大整数（raw amount / sqrtPriceX96 / totalSupply）存 TEXT。
 */
import { db } from '../db.js';

/** 迁移版本。加表/加列时递增，并在 MIGRATIONS 里追加一段幂等 SQL。 */
export const POST_SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
-- 候选代币注册表。tier 决定采集频率（hot/warm/cold），track_until 是生命周期预算。
CREATE TABLE IF NOT EXISTS post_tokens (
  chain_id       INTEGER NOT NULL,
  ca             TEXT NOT NULL,              -- EVM 一律小写
  symbol         TEXT,
  name           TEXT,
  decimals       INTEGER,
  first_trade_ts INTEGER,                    -- 最早可信成交时间；币龄以它为准，不是部署时间
  first_trade_evidence TEXT,                 -- 该时间是怎么来的（block/tx/回补范围）
  deploy_ts      INTEGER,                    -- 另记，不当币龄
  age_quality    TEXT NOT NULL DEFAULT 'unknown',   -- verified | age_unverified | unknown
  first_seen_at  INTEGER NOT NULL,           -- 本系统第一次看到
  tier           TEXT NOT NULL DEFAULT 'cold',      -- hot | warm | cold
  track_until    INTEGER,
  meta_updated_ts INTEGER,
  PRIMARY KEY (chain_id, ca)
);
CREATE INDEX IF NOT EXISTS idx_post_tokens_tier ON post_tokens(tier, track_until);
CREATE INDEX IF NOT EXISTS idx_post_tokens_seen ON post_tokens(first_seen_at);

-- 池。post 自己存一份，不读旧 pools 表（见文件头说明）。
CREATE TABLE IF NOT EXISTS post_pools (
  chain_id    INTEGER NOT NULL,
  pool_id     TEXT NOT NULL,
  ca          TEXT NOT NULL,
  quote       TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL,
  token_is0   INTEGER NOT NULL,
  token_decimals INTEGER,
  fee         INTEGER,
  hooks       TEXT,
  init_block  INTEGER NOT NULL,
  init_ts     INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (chain_id, pool_id)
);
CREATE INDEX IF NOT EXISTS idx_post_pools_ca ON post_pools(chain_id, ca);

-- 候选来源。同一个 CA 被多个来源发现时各存一行，不互相覆盖。
CREATE TABLE IF NOT EXISTS post_discoveries (
  source         TEXT NOT NULL,              -- chain | debot | manual
  source_event_id TEXT NOT NULL,
  chain_id       INTEGER NOT NULL,
  ca             TEXT NOT NULL,
  pool_id        TEXT,
  event_ts       INTEGER,                    -- 来源声称的发生时间，可为空
  observed_at    INTEGER NOT NULL,           -- 本系统观测到的时间
  available_at   INTEGER NOT NULL,           -- 策略最早可以用它的时间（无前视）
  evidence_ref   TEXT,
  payload        TEXT,
  PRIMARY KEY (source, source_event_id, chain_id, ca)
);
CREATE INDEX IF NOT EXISTS idx_post_disc_ca ON post_discoveries(chain_id, ca, available_at);

-- 规范化 Swap 事件。旧 swaps 表只有 pool/block/log/ts/usd，还原不了 OHLC。
CREATE TABLE IF NOT EXISTS post_swaps (
  chain_id    INTEGER NOT NULL,
  block_hash  TEXT NOT NULL,
  tx_hash     TEXT NOT NULL,
  log_idx     INTEGER NOT NULL,
  pool_id     TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  tx_index    INTEGER NOT NULL,
  event_ts    INTEGER NOT NULL,              -- 真实区块时间
  observed_at INTEGER NOT NULL,
  amount0     TEXT NOT NULL,
  amount1     TEXT NOT NULL,
  sqrt_price_x96 TEXT NOT NULL,
  liquidity   TEXT,
  tick        INTEGER,
  token_price_quote REAL,                    -- 成交后池价（以计价币计）
  quote_id    TEXT,                          -- 关联 post_quotes 的时点报价
  price_usd   REAL,
  volume_usd  REAL,                          -- 只算 quote 侧一边，绝不两边相加
  quote_quality TEXT NOT NULL DEFAULT 'missing',  -- historical | live | peg_proxy | missing
  PRIMARY KEY (chain_id, block_hash, tx_hash, log_idx)
);
CREATE INDEX IF NOT EXISTS idx_post_swaps_pool_ts ON post_swaps(chain_id, pool_id, event_ts);
CREATE INDEX IF NOT EXISTS idx_post_swaps_block   ON post_swaps(chain_id, block_number);
-- 待定价的成交要能单独捞出来：报价故障不能逼着丢原始日志（§10）。
CREATE INDEX IF NOT EXISTS idx_post_swaps_unpriced ON post_swaps(quote_quality, event_ts);

-- 时点报价。历史换算只找「事件时点之前、且当时真的可用」的报价。
CREATE TABLE IF NOT EXISTS post_quotes (
  source      TEXT NOT NULL,                 -- coinbase | coingecko | blockscout | peg
  asset       TEXT NOT NULL,                 -- ETH | USDG …
  quote_ts    INTEGER NOT NULL,              -- 这条报价代表的时点
  usd         REAL NOT NULL,
  available_at INTEGER NOT NULL,             -- 系统真正拿到它的时间
  quality     TEXT NOT NULL,                 -- historical | live | peg_proxy
  version     TEXT,
  PRIMARY KEY (source, asset, quote_ts)
);
CREATE INDEX IF NOT EXISTS idx_post_quotes_lookup ON post_quotes(asset, quote_ts);

-- 供应量时点快照。历史 FDV 只能用当时的供应量，不能拿今天的倒算。
CREATE TABLE IF NOT EXISTS post_supplies (
  chain_id      INTEGER NOT NULL,
  ca            TEXT NOT NULL,
  observed_block INTEGER NOT NULL,
  total_supply  TEXT NOT NULL,
  decimals      INTEGER NOT NULL,
  observed_ts   INTEGER NOT NULL,
  available_at  INTEGER NOT NULL,
  source        TEXT NOT NULL,
  PRIMARY KEY (chain_id, ca, observed_block)
);
CREATE INDEX IF NOT EXISTS idx_post_supplies_ts ON post_supplies(chain_id, ca, observed_ts);

-- 采集覆盖。水位表示「连续完成至此」，不是见过的最大 block。
CREATE TABLE IF NOT EXISTS post_coverage (
  chain_id    INTEGER NOT NULL,
  pool_id     TEXT NOT NULL,                 -- '*' 表示全链级的 Initialize 流
  stream      TEXT NOT NULL,                 -- realtime | backfill
  from_block  INTEGER NOT NULL,
  to_block    INTEGER NOT NULL,
  from_ts     INTEGER,
  to_ts       INTEGER,
  last_hash   TEXT,
  status      TEXT NOT NULL,                 -- complete | gap | pending
  note        TEXT,
  PRIMARY KEY (chain_id, pool_id, stream, from_block)
);
CREATE INDEX IF NOT EXISTS idx_post_coverage_status ON post_coverage(status, chain_id, pool_id);

-- series：一个 episode 固定一个 series，口径变了必须换 series 而不是静默改历史。
CREATE TABLE IF NOT EXISTS post_series (
  series_id     TEXT PRIMARY KEY,
  chain_id      INTEGER NOT NULL,
  ca            TEXT NOT NULL,
  pool_id       TEXT NOT NULL,
  price_source  TEXT NOT NULL,               -- swap_post_price
  quote_policy  TEXT NOT NULL,               -- 计价方式版本
  supply_policy TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  end_reason    TEXT,
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_post_series_ca ON post_series(chain_id, ca, started_at);

CREATE TABLE IF NOT EXISTS post_candles (
  series_id     TEXT NOT NULL,
  timeframe_sec INTEGER NOT NULL,
  open_ts       INTEGER NOT NULL,
  close_ts      INTEGER NOT NULL,
  available_at  INTEGER NOT NULL,
  open  REAL, high REAL, low REAL, close REAL,
  volume_usd    REAL,
  volume_all_pools_usd REAL,                 -- 仅供展示，不能冒充主池量
  swaps         INTEGER NOT NULL DEFAULT 0,
  fdv_close_usd REAL,
  closed        INTEGER NOT NULL DEFAULT 0,
  synthetic     INTEGER NOT NULL DEFAULT 0,
  quality       TEXT NOT NULL,               -- complete | partial | stale | unknown
  source        TEXT NOT NULL,
  quote_quality TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (series_id, timeframe_sec, open_ts)
);
CREATE INDEX IF NOT EXISTS idx_post_candles_tf ON post_candles(timeframe_sec, open_ts);

-- episode：一次形态跟踪的完整生命周期。anchor 是已确认的第一波/launch 事件，
-- 不是进程启动时刻，这样重启不会凭空产生新 episode。
CREATE TABLE IF NOT EXISTS post_episodes (
  episode_id    TEXT PRIMARY KEY,
  chain_id      INTEGER NOT NULL,
  ca            TEXT NOT NULL,
  strategy      TEXT NOT NULL,               -- second_leg | new_pullback | million_reclaim
  anchor_id     TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  series_id     TEXT,
  state         TEXT NOT NULL,
  state_since   INTEGER NOT NULL,
  frozen        TEXT,                        -- 冻结的边界/极值 JSON，终态前不得被新极值重写
  clocks        TEXT,                        -- rangeStartTs 等时钟 JSON
  last_processed_bar INTEGER,
  config_hash   TEXT NOT NULL,
  config_snapshot TEXT,
  revision      INTEGER NOT NULL DEFAULT 1,
  terminal      INTEGER NOT NULL DEFAULT 0,
  run_id        TEXT NOT NULL DEFAULT 'live',  -- 回放用独立 runId，不污染 live
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (chain_id, ca, strategy, anchor_id, version, run_id)
);
CREATE INDEX IF NOT EXISTS idx_post_ep_state ON post_episodes(run_id, terminal, state);
CREATE INDEX IF NOT EXISTS idx_post_ep_ca    ON post_episodes(chain_id, ca, strategy);

-- 叙事报告。与 CA 的绑定证据、来源、时间全部留痕。
CREATE TABLE IF NOT EXISTS post_narratives (
  report_id     TEXT PRIMARY KEY,
  chain_id      INTEGER NOT NULL,
  ca            TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  analyzed_at   INTEGER NOT NULL,
  available_at  INTEGER NOT NULL,
  valid_until   INTEGER,
  status        TEXT NOT NULL,               -- pass | watch | reject | unknown
  category      TEXT NOT NULL,
  summary       TEXT,
  ca_binding    TEXT NOT NULL,               -- verified | unverified | conflict
  novelty       TEXT NOT NULL,               -- new_in_index | repeated | insufficient_history
  market_resonance TEXT NOT NULL,            -- supported | weak | unknown
  claims        TEXT,                        -- JSON
  previous_same_chain TEXT,                  -- JSON
  reason_codes  TEXT,
  reviewer      TEXT NOT NULL,               -- human | model
  model_id      TEXT, prompt_version TEXT, input_hash TEXT, corpus_version TEXT,
  confidence_label TEXT,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_post_narr_ca ON post_narratives(chain_id, ca, available_at);

-- 同链题材库。失败/归零的项目也保留，删掉坏样本会虚增新鲜感。
CREATE TABLE IF NOT EXISTS post_topics (
  topic_id      TEXT PRIMARY KEY,
  chain_id      INTEGER NOT NULL,
  category      TEXT NOT NULL,
  concept       TEXT NOT NULL,               -- 规范化概念实体，不是宽泛的「AI」
  event_key     TEXT,
  first_observed_at INTEGER NOT NULL,
  source_published_at INTEGER,
  available_at  INTEGER NOT NULL,
  coverage_note TEXT NOT NULL,
  evidence      TEXT
);
CREATE INDEX IF NOT EXISTS idx_post_topics_concept ON post_topics(chain_id, concept);

CREATE TABLE IF NOT EXISTS post_topic_links (
  topic_id      TEXT NOT NULL,
  chain_id      INTEGER NOT NULL,
  ca            TEXT NOT NULL,
  linked_at     INTEGER NOT NULL,
  similarity_reason TEXT,
  evidence      TEXT,
  outcome       TEXT,                        -- 保留失败样本：rugged | faded | unknown …
  PRIMARY KEY (topic_id, chain_id, ca)
);
CREATE INDEX IF NOT EXISTS idx_post_tlinks_ca ON post_topic_links(chain_id, ca);

-- 逐条规则的评估结果。被拒样本必须留下，才能回答「为什么没推」。
CREATE TABLE IF NOT EXISTS post_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  episode_id    TEXT,
  chain_id      INTEGER NOT NULL,
  ca            TEXT NOT NULL,
  strategy      TEXT NOT NULL,
  rule          TEXT NOT NULL,
  result        TEXT NOT NULL,               -- pass | fail | unknown
  observed      TEXT,
  threshold     TEXT,
  reason        TEXT NOT NULL,
  as_of         INTEGER NOT NULL,
  available_at  INTEGER NOT NULL,
  input_hash    TEXT,
  evidence_refs TEXT,
  run_id        TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_post_eval_ep ON post_evaluations(episode_id, as_of);
CREATE INDEX IF NOT EXISTS idx_post_eval_ca ON post_evaluations(chain_id, ca, as_of);

-- 信号。signal_id 由 episode/eventType/eventSeq 稳定生成，不用 Date.now() 去重。
CREATE TABLE IF NOT EXISTS post_signals (
  signal_id     TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL,
  chain_id      INTEGER NOT NULL,
  ca            TEXT NOT NULL,
  strategy      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  event_seq     INTEGER NOT NULL,
  group_id      TEXT NOT NULL,               -- 同币同桶的多个理由合成一张卡
  priority      TEXT NOT NULL,               -- P0 | P1 | P2
  detected_at   INTEGER NOT NULL,            -- 形态首次被发现
  confirmed_at  INTEGER NOT NULL,            -- 收盘确认时点，绝不回填成极值时间
  bar_close_ts  INTEGER NOT NULL,
  snapshot      TEXT NOT NULL,               -- 不可变输入快照 JSON
  quality       TEXT NOT NULL,
  config_hash   TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1,
  run_id        TEXT NOT NULL DEFAULT 'live',
  UNIQUE (episode_id, event_type, event_seq, run_id)
);
CREATE INDEX IF NOT EXISTS idx_post_sig_group ON post_signals(group_id);
CREATE INDEX IF NOT EXISTS idx_post_sig_time  ON post_signals(run_id, confirmed_at);

-- 持久 outbox。内存队列在进程死掉时会静默丢任务，这张表才是真相。
CREATE TABLE IF NOT EXISTS post_outbox (
  outbox_id     TEXT PRIMARY KEY,
  signal_id     TEXT NOT NULL,
  group_id      TEXT NOT NULL,
  op            TEXT NOT NULL,               -- send | edit
  revision      INTEGER NOT NULL DEFAULT 1,
  destination   TEXT NOT NULL,
  mode          TEXT NOT NULL,               -- off | telegram，两种模式的引用严格隔离
  state         TEXT NOT NULL,               -- pending | sending | sent | unknown | failed | expired
  attempt       INTEGER NOT NULL DEFAULT 0,
  lease_until   INTEGER,
  due_at        INTEGER NOT NULL,
  deadline_at   INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  message_id    INTEGER,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  run_id        TEXT NOT NULL DEFAULT 'live',
  UNIQUE (signal_id, op, revision, destination, mode, run_id)
);
CREATE INDEX IF NOT EXISTS idx_post_outbox_due ON post_outbox(state, due_at);

-- 已发出消息的引用。off 与 telegram 的 message_id 严格分开，切模式不互相污染。
CREATE TABLE IF NOT EXISTS post_message_refs (
  group_id      TEXT NOT NULL,
  destination   TEXT NOT NULL,
  mode          TEXT NOT NULL,
  chat_id       TEXT,
  message_id    INTEGER,
  delivered     INTEGER NOT NULL DEFAULT 0,
  last_revision INTEGER NOT NULL DEFAULT 0,
  first_sent_at INTEGER,
  updated_at    INTEGER NOT NULL,
  run_id        TEXT NOT NULL DEFAULT 'live',
  PRIMARY KEY (group_id, destination, mode, run_id)
);

-- 人工持仓参考价。只用于显示相对变化，不算净收益，不维护「已卖出」状态。
CREATE TABLE IF NOT EXISTS post_reference_entries (
  chain_id   INTEGER NOT NULL,
  ca         TEXT NOT NULL,
  entry_ts   INTEGER NOT NULL,
  price_usd  REAL NOT NULL,
  quantity   REAL,
  note       TEXT,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, ca, entry_ts)
);
`,
};

function currentVersion(): number {
  const row = db.prepare("SELECT v FROM cursor WHERE k='post_schema_version'").get() as { v: string } | undefined;
  return row ? Number(row.v) : 0;
}

/** 幂等迁移。每一版单独一个事务，中途失败不会留下半套表。 */
export function migratePostSchema(): number {
  let from = currentVersion();
  for (let v = from + 1; v <= POST_SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) throw new Error(`缺少 post schema 迁移 v${v}`);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare("INSERT INTO cursor (k,v) VALUES ('post_schema_version', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
        .run(String(v));
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  }
  return POST_SCHEMA_VERSION - from;
}

/** post 侧的表清单，给 dbstat / 报告用。 */
export const POST_TABLES = [
  'post_tokens', 'post_pools', 'post_discoveries', 'post_swaps', 'post_quotes', 'post_supplies',
  'post_coverage', 'post_series', 'post_candles', 'post_episodes', 'post_narratives', 'post_topics',
  'post_topic_links', 'post_evaluations', 'post_signals', 'post_outbox', 'post_message_refs',
  'post_reference_entries',
] as const;

// ── 保留策略（§5.4） ────────────────────────────────────────────────────────

export interface RetentionBudget {
  rawRetentionDays: number;
  candle1mRetentionDays: number;
  candleHigherRetentionDays: number;
  evidenceRetentionDays: number;
}

export interface RetentionResult { table: string; deleted: number; kept: string }

/**
 * 分批小事务清理。三条不能裁的红线：
 *   1. 未终结 episode 引用的 series，它的 K 线一根都不能删（二段要横 2–4 天）；
 *   2. 还没定价、还没聚合的原始事件不能删（报价故障恢复后要补算）；
 *   3. 未终结 outbox 引用的 signal / evidence 不能删。
 */
export function prunePost(now: number, budget: RetentionBudget): RetentionResult[] {
  const D = 86_400_000;
  const out: RetentionResult[] = [];
  const run = (table: string, sql: string, kept: string, ...args: unknown[]) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = db.prepare(sql).run(...(args as any[]));
      db.exec('COMMIT');
      out.push({ table, deleted: Number(r.changes), kept });
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  };

  // 活跃 series = 被未终结 episode 引用的。它的 K 线与原始事件一律豁免。
  const activeSeries = `SELECT series_id FROM post_episodes WHERE terminal = 0 AND series_id IS NOT NULL`;
  const activePools = `SELECT pool_id FROM post_series WHERE series_id IN (${activeSeries})`;

  run('post_swaps',
    `DELETE FROM post_swaps WHERE event_ts < ?
       AND quote_quality != 'missing'
       AND pool_id NOT IN (${activePools})`,
    '未定价的成交与活跃 episode 的池豁免',
    now - budget.rawRetentionDays * D);

  run('post_candles',
    `DELETE FROM post_candles WHERE timeframe_sec = 60 AND open_ts < ?
       AND series_id NOT IN (${activeSeries})`,
    '活跃 episode 的 series 豁免',
    now - budget.candle1mRetentionDays * D);

  run('post_candles',
    `DELETE FROM post_candles WHERE timeframe_sec > 60 AND open_ts < ?
       AND series_id NOT IN (${activeSeries})`,
    '活跃 episode 的 series 豁免',
    now - budget.candleHigherRetentionDays * D);

  run('post_evaluations',
    `DELETE FROM post_evaluations WHERE as_of < ?
       AND (episode_id IS NULL OR episode_id NOT IN (SELECT episode_id FROM post_episodes WHERE terminal = 0))`,
    '未终结 episode 的评估豁免',
    now - budget.evidenceRetentionDays * D);

  run('post_signals',
    `DELETE FROM post_signals WHERE confirmed_at < ?
       AND signal_id NOT IN (SELECT signal_id FROM post_outbox WHERE state IN ('pending','sending','unknown'))`,
    '未终结 outbox 引用的信号豁免',
    now - budget.evidenceRetentionDays * D);

  run('post_quotes', `DELETE FROM post_quotes WHERE quote_ts < ?`, '按证据保留期',
    now - budget.evidenceRetentionDays * D);

  run('post_outbox',
    `DELETE FROM post_outbox WHERE updated_at < ? AND state IN ('sent','failed','expired')`,
    '终态任务才清，pending/sending/unknown 永不自动清',
    now - budget.evidenceRetentionDays * D);

  // 题材首次出现摘要长期保留（§5.4），这里不清 post_topics。
  return out;
}

/**
 * 模块加载即建表。下游模块（quotes/events/candles…）在顶层就 `db.prepare(...)`，
 * 表必须先存在；ESM 深度优先求值依赖，所以它们 import 本模块即可保证顺序。
 * legacy 模式不会 import post 模块，也就不会建这些表。
 */
migratePostSchema();
