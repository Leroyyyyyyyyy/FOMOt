import { rules, links, chain } from '../config.js';
import { fmtUsd, fmtAmount, fmtCount } from '../chain/pricing.js';

export interface LeaderHolder {
  rank: number; handle: string; balance: number; followers: number | null; pnl24h: number;
  /** 该持仓是链上余额确认的，还是仅由 FOMO 自报的持仓表得来 */
  identityConfirmed: boolean;
}
export interface AlertData {
  ca: string;
  symbol: string;
  name: string;
  marketCapUsd: number;
  triggerTs: number;
  volume5m: number;
  volume1h: number;
  // offsetMs 是实测的、相对首次触发的真实耗时，不是配置里的标称值——
  // 卡片上那个 (+0.8s) 是精度招牌，写死会变成假话
  initial: { total: number; fomo: number | null; offsetMs: number } | null;
  recheck: { total: number; fomo: number | null; offsetMs: number } | null;
  leaderboardHolders: LeaderHolder[];
  leaderboardAvailable: boolean;
  /** 榜单交集只能表示「已确认至少 N 人」——识别覆盖不全时不能当成完整人数 */
  leaderboardPartial: boolean;
  top10: {
    /** 该币累计收益合计（已实现+未实现，全时段）。不是 24H，也不是全平台。 */
    tokenPnlTotal: number | null;
    tokenPnlCovered: number;
    /** 按该币累计收益统计的盈利人数，与 tokenPnlTotal 同口径 */
    tokenProfitable: number | null;
    /** 全平台 24H 收益合计。取不到就是 null，绝不用该币收益顶替。 */
    platformPnl24h: number | null;
    platformCovered: number;
    platformWindow: 'live' | 'snapshot' | 'mixed' | null;
    identified: number;
    count: number;
    offsetMs: number;
  };
  health: {
    sourceOk: boolean;
    holderCoverage: [number, number] | null;   // 已识别身份 / 持币人总数
    ingestMs: number | null;
    /** 禁发送模式下明确标出来，免得把演练当成真的推送过 */
    notifyMode: 'off' | 'telegram';
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 2026/09/04 04:56:44.727 HKT —— 毫秒是原版就有的，触发精度是卖点 */
export function fmtTime(ts: number): string {
  const tz = rules.render.timezone;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(ts).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  const ms = String(ts % 1000).padStart(3, '0');
  const abbr = tz === 'Asia/Hong_Kong' ? 'HKT' : tz;
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}.${ms} ${abbr}`;
}

/** 市值档位灯：小盘黄、中盘绿、超大盘红（回到高风险区） */
function mcDot(mc: number): string {
  if (mc < 100_000) return '🟢';
  if (mc < 10_000_000) return '🟡';
  return '🔴';
}

const signed = (n: number) => `${n >= 0 ? '+' : '-'}${fmtUsd(Math.abs(n))}`;
const pct = (a: number, b: number) => (b > 0 ? ` (${((a / b) * 100).toFixed(1)}%)` : '');

/** 0.8s / 5m1s —— 跟原版一样的写法 */
function fmtOffset(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${total % 60}s`;   // 先取整再拆，避免 119999ms 渲染成 1m60s
}

function holderLine(label: string, snap: { total: number; fomo: number | null; offsetMs: number } | null): string {
  if (!snap) return `${label}（<i>采集中…</i>）`;
  const fomo = snap.fomo === null ? '· Fomo <i>n/a</i>' : `· Fomo ${snap.fomo}${pct(snap.fomo, snap.total)}`;
  return `${label}（+${fmtOffset(snap.offsetMs)}）: 全链 ${snap.total} ${fomo}`;
}

export function renderCard(d: AlertData): string {
  const L: string[] = [];
  L.push('<b>FOMO NOW</b>');
  L.push(`${esc(d.name)} (${esc(d.symbol)}) · 🟢 ${chain.name} · MC: ${mcDot(d.marketCapUsd)} <b>${fmtUsd(d.marketCapUsd)}</b>`);
  L.push(`CA: <code>${d.ca}</code>`);
  L.push(`首次触发: ${fmtTime(d.triggerTs)}`);
  L.push(`成交量: 5m ${fmtUsd(d.volume5m)} · 1h ${fmtUsd(d.volume1h)}`);
  L.push(holderLine('持币初值', d.initial));
  L.push(holderLine('持币复核', d.recheck));
  L.push('');

  // 识别覆盖不全时，交集只能说「已确认至少 N 人」——没发现不等于不存在。
  const n = d.leaderboardHolders.length;
  const boardCount = !d.leaderboardAvailable ? '<i>n/a</i>'
    : !d.leaderboardPartial ? `${n} 人`
    // 覆盖不全时「已确认至少 0 人」等于没说；直接讲清楚是「没找到」而不是「确定没有」
    : n === 0 ? '<i>未发现（身份识别不全，不代表没有）</i>'
    : `已确认至少 ${n} 人`;
  L.push(`Fomo 24H盈利榜持有人: ${boardCount}`);
  for (const h of d.leaderboardHolders.slice(0, 5)) {
    const fans = h.followers === null ? '' : ` · 粉丝 ${fmtCount(h.followers)}`;
    const mark = h.identityConfirmed ? '' : ' <i>(持仓据 Fomo 自报)</i>';
    L.push(`• #${h.rank} <b>${esc(h.handle)}</b> · ${fmtAmount(h.balance)} ${esc(d.symbol)}${fans} · 全平台24h ${signed(h.pnl24h)}${mark}`);
  }

  const t = d.top10;
  L.push(`Top10持币账户（+${fmtOffset(t.offsetMs)}）· 账户识别 ${t.identified}/${t.count}`);
  // 该币收益与全平台 24H 收益是两个量，必须分行分标签（docs/FIELDS.md §2.1）
  const tokenPnl = t.tokenPnlTotal === null
    ? `<i>n/a</i>（${t.tokenPnlCovered}/${t.count}）`
    : `${signed(t.tokenPnlTotal)}${t.tokenProfitable === null ? '' : ` · 盈利 ${t.tokenProfitable} 人`}`;
  L.push(`  该币累计收益（已实现+未实现）: ${tokenPnl}`);
  const win = t.platformWindow === 'live' ? '实时' : t.platformWindow === 'snapshot' ? '整点对齐' : null;
  const platPnl = t.platformPnl24h === null
    ? `<i>n/a</i>（${t.platformCovered}/${t.count}）`
    : `${signed(t.platformPnl24h)}${win ? ` · ${win}口径` : ''}`;
  L.push(`  全平台24H PnL: ${platPnl}`);
  L.push('');

  const h = d.health;
  const cov = h.holderCoverage ? ` · 持币覆盖 ${h.holderCoverage[0]}/${h.holderCoverage[1]}` : '';
  const ingest = h.ingestMs === null ? 'n/a' : `${h.ingestMs}ms`;
  const mode = h.notifyMode === 'off' ? ' · <i>禁发送演练</i>' : '';
  // Top10 覆盖直接取 d.top10，别再单独存一份——两份会各自漂移
  L.push(`健康: ${h.sourceOk ? '🟢 实时源正常' : '🔴 实时源异常'}${cov} · Top10 ${t.identified}/${t.count} · 浏览器→入库 ${ingest}${mode}`);

  return L.join('\n');
}

export function renderButtons(ca: string) {
  return {
    inline_keyboard: [
      [{ text: '🐰 Fomo', url: links.fomo(ca) }],
      [{ text: '🦎 GMGN', url: links.gmgn(ca) }],
      [{ text: '🔎 Blockscout', url: links.scout(ca) }],
    ],
  };
}
