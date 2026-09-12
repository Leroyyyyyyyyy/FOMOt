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

if (!token) {
  bad('TELEGRAM_BOT_TOKEN 是空的。找 @BotFather 建 bot 拿 token，填进 .env 再跑。');
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

  /**
   * chat_id 还没填时，帮忙把 bot 能看到的频道/群列出来。
   * 私有频道拿不到 @username，只能用 -100 开头的数字 id——它就在这里。
   * 前提：bot 已经是频道管理员，且频道里**发过至少一条消息**（getUpdates 才有内容）。
   */
  if (!chatId) {
    bad('TELEGRAM_CHAT_ID 是空的。');
    const ups = await api<any[]>('getUpdates', { limit: 100, allowed_updates: ['channel_post', 'message', 'my_chat_member'] });
    const seen = new Map<number, { title: string; type: string; username?: string }>();
    for (const u of ups) {
      const c = u.channel_post?.chat ?? u.message?.chat ?? u.my_chat_member?.chat;
      if (c?.id) seen.set(c.id, { title: c.title ?? c.username ?? String(c.id), type: c.type, username: c.username });
    }
    if (seen.size) {
      console.error('\n   bot 目前能看到这些会话，把想用的那个填进 .env：');
      for (const [id, c] of seen) {
        console.error(`     ${c.username ? `@${c.username}` : id}   ${c.title}  (type=${c.type}${c.username ? `, 数字 id ${id}` : ''})`);
      }
    } else {
      console.error('\n   getUpdates 里还没有任何会话。请确认：');
      console.error('     1) bot 已被拉进频道并设为管理员；');
      console.error('     2) 频道里发过至少一条消息（哪怕是你自己发的），否则 Telegram 不会给出 update。');
      console.error('   公开频道也可以直接填 @频道用户名，不用查数字 id。');
    }
    process.exit(1);
  }

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
