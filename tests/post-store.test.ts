import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { pruneAll } from '../src/db.js';
import { migratePostSchema, prunePost, POST_TABLES, POST_SCHEMA_VERSION } from '../src/post/store.js';

migratePostSchema();

const D = 86_400_000;
const NOW = 1_800_000_000_000;
const budget = { rawRetentionDays: 7, candle1mRetentionDays: 14, candleHigherRetentionDays: 90, evidenceRetentionDays: 180 };

function reset() {
  for (const t of POST_TABLES) db.exec(`DELETE FROM ${t}`);
}
test.beforeEach(reset);

function series(id: string, poolId: string) {
  db.prepare(`INSERT INTO post_series (series_id, chain_id, ca, pool_id, price_source, quote_policy, supply_policy, started_at)
    VALUES (?,4663,'0xca',?, 'swap_post_price','v1','v1',?)`).run(id, poolId, NOW - 100 * D);
}
function episode(id: string, seriesId: string, terminal: number) {
  db.prepare(`INSERT INTO post_episodes (episode_id, chain_id, ca, strategy, anchor_id, series_id, state, state_since,
      config_hash, terminal, created_at, updated_at)
    VALUES (?,4663,'0xca','second_leg',?,?, 'RANGE_TRACKING', ?, 'h', ?, ?, ?)`)
    .run(id, `anchor-${id}`, seriesId, NOW, terminal, NOW, NOW);
}
function candle(seriesId: string, tf: number, openTs: number) {
  db.prepare(`INSERT INTO post_candles (series_id, timeframe_sec, open_ts, close_ts, available_at,
      open, high, low, close, swaps, closed, synthetic, quality, source, quote_quality)
    VALUES (?,?,?,?,?, 1,1,1,1, 1, 1, 0, 'complete','chain','live')`)
    .run(seriesId, tf, openTs, openTs + tf * 1000, openTs + tf * 1000);
}
function swap(poolId: string, ts: number, quoteQuality: string) {
  db.prepare(`INSERT INTO post_swaps (chain_id, block_hash, tx_hash, log_idx, pool_id, block_number, tx_index,
      event_ts, observed_at, amount0, amount1, sqrt_price_x96, quote_quality)
    VALUES (4663, ?, ?, 0, ?, 1, 0, ?, ?, '1','-1','1',?)`)
    .run(`0xb${ts}${poolId}`, `0xt${ts}${poolId}`, poolId, ts, ts, quoteQuality);
}
const count = (t: string, where = '1=1') => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${where}`).get() as any).n;

test('迁移幂等：重复跑不报错，版本号不倒退', () => {
  assert.equal(migratePostSchema(), 0, '已经是最新版时不应再跑迁移');
  const v = (db.prepare("SELECT v FROM cursor WHERE k='post_schema_version'").get() as any).v;
  assert.equal(Number(v), POST_SCHEMA_VERSION);
});

test('所有 post_* 表都真的建出来了', () => {
  const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r => r.name));
  for (const t of POST_TABLES) assert.ok(names.has(t), `缺表 ${t}`);
});

test('旧 pruneAll 动不了 post 侧数据——这是二段能横 2–4 天的前提', () => {
  // 旧表里塞一个 24h 以前的池 + 成交，pruneAll 会把它们删掉。
  db.prepare(`INSERT INTO pools (pool_id, ca, quote, token_is0, fee, hooks, init_block, init_ts)
    VALUES ('0xp1','0xca','0x0',1,0,'0x0',1,?)`).run(Date.now() - 3 * D);
  db.prepare('INSERT INTO swaps (pool_id, block, log_idx, ts, usd) VALUES (?,?,?,?,?)')
    .run('0xp1', 1, 0, Date.now() - 3 * D, 10);
  // post 侧同一个池的历史
  series('s1', '0xp1');
  episode('e1', 's1', 0);
  candle('s1', 900, Date.now() - 3 * D);
  swap('0xp1', Date.now() - 3 * D, 'live');

  pruneAll();

  assert.equal(count('pools'), 0, '旧表按原有 24h 策略清掉（不改旧行为）');
  assert.equal(count('post_candles'), 1, 'post K 线必须还在');
  assert.equal(count('post_swaps'), 1, 'post 原始成交必须还在');
  assert.equal(count('post_series'), 1);
});

test('未终结 episode 引用的 series，K 线一根都不能删', () => {
  series('live', '0xpA');
  series('dead', '0xpB');
  episode('e-live', 'live', 0);
  episode('e-dead', 'dead', 1);
  candle('live', 900, NOW - 200 * D);
  candle('dead', 900, NOW - 200 * D);
  candle('live', 60, NOW - 200 * D);
  candle('dead', 60, NOW - 200 * D);

  prunePost(NOW, budget);

  assert.equal(count('post_candles', "series_id='live'"), 2, '活跃 episode 的 K 线豁免');
  assert.equal(count('post_candles', "series_id='dead'"), 0, '已终结的按保留期清理');
});

test('还没定价的原始成交不清——报价故障恢复后还要补算', () => {
  series('s', '0xpZ');
  episode('e', 's', 1);                      // 已终结，池不受豁免
  swap('0xpZ', NOW - 30 * D, 'live');
  swap('0xpZ', NOW - 30 * D + 1, 'missing');

  prunePost(NOW, budget);

  assert.equal(count('post_swaps', "quote_quality='missing'"), 1, 'missing 的成交必须留着');
  assert.equal(count('post_swaps', "quote_quality='live'"), 0);
});

test('pending/sending/unknown 的 outbox 永不自动清，它引用的 signal 也保住', () => {
  let seq = 0;
  const ins = (id: string, state: string, updated: number) => {
    seq++;
    db.prepare(`INSERT INTO post_signals (signal_id, episode_id, chain_id, ca, strategy, event_type, event_seq,
        group_id, priority, detected_at, confirmed_at, bar_close_ts, snapshot, quality, config_hash)
      VALUES (?, 'e', 4663, '0xca', 'second_leg', 'READY', ?, ?, 'P1', ?, ?, ?, '{}', 'complete', 'h')`)
      .run(id, seq, `g-${id}`, NOW - 300 * D, NOW - 300 * D, NOW - 300 * D);
    db.prepare(`INSERT INTO post_outbox (outbox_id, signal_id, group_id, op, destination, mode, state,
        due_at, deadline_at, payload, created_at, updated_at)
      VALUES (?, ?, ?, 'send', 'tg', 'off', ?, ?, ?, '{}', ?, ?)`)
      .run(`o-${id}`, id, `g-${id}`, state, NOW, NOW, NOW - 300 * D, updated);
  };
  ins('sig-pending', 'pending', NOW - 300 * D);
  ins('sig-sent', 'sent', NOW - 300 * D);

  prunePost(NOW, budget);

  assert.equal(count('post_outbox', "outbox_id='o-sig-pending'"), 1, 'pending 任务不能被清理吞掉');
  assert.equal(count('post_outbox', "outbox_id='o-sig-sent'"), 0, '终态任务过期后才清');
  assert.equal(count('post_signals', "signal_id='sig-pending'"), 1, '未送达信号必须留证据');
  assert.equal(count('post_signals', "signal_id='sig-sent'"), 0);
});

test('题材库长期保留，不按保留期清——删掉坏样本会虚增新鲜感', () => {
  db.prepare(`INSERT INTO post_topics (topic_id, chain_id, category, concept, first_observed_at, available_at, coverage_note)
    VALUES ('t1',4663,'science','某具体果蝇脑模拟研究', ?, ?, '本地覆盖 30 天')`).run(NOW - 900 * D, NOW - 900 * D);
  prunePost(NOW, budget);
  assert.equal(count('post_topics'), 1);
});
