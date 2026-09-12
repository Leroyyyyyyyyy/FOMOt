/**
 * Telegram 三条路径的实发自检：send → edit → delete。
 *
 * **会往频道真发一条消息，然后自己删掉。**内容是明确标注的自检卡片，
 * 用的是真实的 renderCard 渲染，走的是真实的 Sender（含限速队列）。
 * 跑完频道里不留任何东西。
 *
 *   NOTIFY_MODE=telegram npx tsx scripts/smoke-telegram.ts
 *
 * 三步各自的意义：
 *   send   → 初值卡能不能发出去
 *   edit   → 复核改写 / 补 PnL 能不能原地改写（缺 can_edit_messages 会在这步炸）
 *   delete → 复核门未过时能不能撤回（缺权限的话，不该留的卡片会留在频道上）
 */
import 'dotenv/config';
import { telegram } from '../src/notify/telegram.js';
import { renderCard, renderButtons, type AlertData } from '../src/notify/render.js';
import { DAY_MS, HOUR_MS } from '../src/engine/pnl.js';

if ((process.env.NOTIFY_MODE ?? 'off').toLowerCase() !== 'telegram') {
  console.error('❌ 需要 NOTIFY_MODE=telegram 才会真的发送。当前是禁发送模式，自检没有意义。');
  process.exit(1);
}

const now = Date.now();
const END = Math.floor(now / HOUR_MS) * HOUR_MS;
const card = (stage: 'send' | 'edit'): AlertData => ({
  ca: '0x' + 'ab'.repeat(20), symbol: 'SMOKE', name: `【接入自检 ${stage}】请忽略`,
  marketCapUsd: 126_120, triggerTs: now - 301_000, volume5m: 22_360, volume1h: 212_120,
  initial: { total: 178, fomo: 72, offsetMs: 800 },
  recheck: stage === 'edit' ? { total: 491, fomo: 336, offsetMs: 301_000 } : null,
  leaderboardHolders: [], leaderboardAvailable: true, leaderboardPartial: false,
  top10: {
    tokenPnlTotal: 1_881_924, tokenPnlCovered: 10, tokenProfitable: 7,
    platformPnl24h: stage === 'edit' ? 500_310 : null,
    platformProfitable: stage === 'edit' ? 7 : null,
    platformCovered: stage === 'edit' ? 10 : 0,
    platformWindow: stage === 'edit' ? { basis: 'snapshot', startTs: END - DAY_MS, endTs: END } : null,
    platformFetchedTs: stage === 'edit' ? now : null,
    platformState: stage === 'edit' ? 'ready' : 'collecting',
    platformReason: stage === 'edit' ? null : '缺 10 人的收益记录',
    identified: 10, count: 10, offsetMs: stage === 'edit' ? 301_000 : 800,
  },
  sources: { chainBlock: '55121759', chainBlockTs: now, chainTakenTs: now, fomoRespTs: now,
    boardTakenTs: now, marketTakenTs: now, sourceSkewMs: 0, degraded: [] },
  health: { sourceOk: true, holderCoverage: [49, 336], ingestMs: 64, notifyMode: 'telegram' },
});

const step = (n: number, s: string) => console.log(`${n}. ${s}`);

const sent = await telegram.send(renderCard(card('send')), renderButtons(card('send').ca));
if (!sent?.message_id) { console.error('❌ send 失败，看上面的 Telegram 报错'); process.exit(1); }
step(1, `✅ send    message_id=${sent.message_id}（频道里现在有一条自检卡）`);

const edited = await telegram.edit(sent.message_id, renderCard(card('edit')), renderButtons(card('edit').ca));
if (edited === null) { console.error(`❌ edit 失败。message_id=${sent.message_id} 还留在频道里，需要手动删。`); process.exit(1); }
step(2, '✅ edit    已原地改写（复核改写 / 补 PnL 走的就是这条）');

const removed = await telegram.remove(sent.message_id);
if (removed === null) { console.error(`❌ delete 失败。message_id=${sent.message_id} 还留在频道里，需要手动删。`); process.exit(1); }
step(3, '✅ delete  已撤回，频道里不留痕迹');

console.log('\n三条路径全通。可以开实跑了：NOTIFY_MODE=telegram npm start');
