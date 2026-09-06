/**
 * Telegram 接入前的自检。**只读**：调用 getMe / getChat / getChatMember，
 * 一条消息都不发。凭据只从环境变量读，不打印到屏幕或文件。
 *
 *   npx tsx scripts/check-telegram.ts
 *
 * 三件事要一起成立，卡片的完整生命周期才跑得通：
 *   send（初值卡）、editMessageText（复核改写、补 PnL）、deleteMessage（复核门未过时撤回）。
 * 少一个权限，前两步能跑、第三步会在实跑里才炸。
 */
import 'dotenv/config';

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
const bad = (m: string) => { console.error(`❌ ${m}`); process.exitCode = 1; };

if (!token || !chatId) {
  bad(`凭据不全：TELEGRAM_BOT_TOKEN=${token ? '已配置' : '空'}  TELEGRAM_CHAT_ID=${chatId ? '已配置' : '空'}`);
  console.error('   在 .env 里填好这两项再跑。找 @BotFather 建 bot 拿 token；');
  console.error('   频道用 @channelname，或把 bot 拉进频道后用 -100 开头的数字 id。');
  process.exit(1);
}

async function api<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params), signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json() as { ok: boolean; result?: T; description?: string };
  if (!j.ok) throw new Error(`${method}: ${j.description ?? res.status}`);
  return j.result as T;
}

try {
  const me = await api<{ id: number; username: string; can_join_groups?: boolean }>('getMe');
  console.log(`✅ token 有效  bot = @${me.username} (id ${me.id})`);

  const chat = await api<{ id: number; type: string; title?: string; username?: string }>('getChat', { chat_id: chatId });
  console.log(`✅ 频道可达  ${chat.title ?? chat.username ?? chat.id} · type=${chat.type} · id=${chat.id}`);
  if (chat.type !== 'channel' && chat.type !== 'supergroup' && chat.type !== 'group') {
    console.warn(`⚠️  type=${chat.type}，原版是频道（channel）；私聊也能发但撤回/改写的权限模型不同`);
  }

  const m = await api<{ status: string; can_post_messages?: boolean; can_edit_messages?: boolean; can_delete_messages?: boolean }>(
    'getChatMember', { chat_id: chatId, user_id: me.id });
  console.log(`   bot 在频道里的身份: ${m.status}`);
  if (m.status !== 'administrator' && m.status !== 'creator') {
    bad('bot 不是频道管理员。频道里非管理员发不了消息，复核改写/撤回更不行。');
  } else {
    const need: [string, boolean | undefined, string][] = [
      ['发消息 can_post_messages', m.can_post_messages, '初值卡发不出去'],
      ['改消息 can_edit_messages', m.can_edit_messages, '复核改写和补 PnL 会失败'],
      ['删消息 can_delete_messages', m.can_delete_messages, '复核门未过时撤不回，会留下错误的卡片'],
    ];
    for (const [label, ok, hurt] of need) {
      // 频道管理员的这三个权限可能是 undefined（老 API 或 creator），只在明确 false 时报错
      if (ok === false) bad(`缺权限：${label} → ${hurt}`);
      else console.log(`   ${ok === true ? '✅' : '➖'} ${label}${ok === undefined ? '（接口未返回，creator 通常全有）' : ''}`);
    }
  }

  console.log(`\n自检完成，全程未发送任何消息。`);
  if (!process.exitCode) {
    console.log(`下一步：NOTIFY_MODE=telegram npm start   （去掉环境变量就回到禁发送）`);
  }
} catch (err) {
  bad(String(err).slice(0, 300));
  console.error('   常见原因：token 抄错、bot 没被拉进频道、chat_id 写错（频道数字 id 要带 -100 前缀）');
}
