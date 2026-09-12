/**
 * prod-api.fomo.family 的精确解析。
 *
 * 端点和字段是把登录态浏览器的响应逐个抓下来对出来的（见 scripts/probe-fields.ts、
 * probe-hodlers.ts）。既然结构已经确定，就别再靠 extract.ts 那套形状启发式猜了——
 * 那个现在只当兜底，用来从其他端点顺手捞身份信息。
 *
 * 所有响应统一包在 { success, message, responseObject, statusCode } 里。
 */

import { strictNum } from '../engine/pnl.js';

export const ROBINHOOD_NETWORK_ID = 4663;

/**
 * 数值解析统一走 `strictNum`：**空值不当成 0**。
 *
 * 旧实现是 `typeof v === 'string' ? Number(v) : …`，而 `Number('')` 和
 * `Number('  ')` 都是 **0**——一个 `pnl: ""` 的持有人会被当成「收益 0 的人」
 * 参与「该币累计收益」求和与盈利人数统计。现在这类值一律是 null（缺失）。
 */
const num = strictNum;

/**
 * 剥掉响应外壳，拿到承载数据的那个数组。
 *
 * 外层统一是 { success, message, responseObject, statusCode }，但 responseObject
 * 里面还不统一：/hodlers/top 直接就是数组，/v2/leaderboard/24h 却是
 * { leaderboard: [...] }。所以剥完还要往里找一层数组。
 */
function unwrap(json: unknown): unknown {
  let cur: unknown = json;
  if (cur && typeof cur === 'object' && 'responseObject' in (cur as object)) {
    cur = (cur as { responseObject: unknown }).responseObject;
  }
  if (Array.isArray(cur)) return cur;
  if (cur && typeof cur === 'object') {
    const vals = Object.values(cur as Record<string, unknown>);
    const arrays = vals.filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];       // 只有一个数组字段，不会歧义
  }
  return cur;
}

export interface FomoUser {
  userId: string | null;
  handle: string | null;
  evmAddress: string | null;
  followers: number | null;
}

function parseUser(u: unknown): FomoUser | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const evm = typeof o['evmAddress'] === 'string' ? o['evmAddress'].toLowerCase() : null;
  return {
    userId: typeof o['id'] === 'string' ? o['id'] : null,
    // 原版卡片显示的是 displayName（截图里是 "frank"，而 userHandle 是 "frankdegods"）
    handle: (typeof o['displayName'] === 'string' && o['displayName']) ||
            (typeof o['userHandle'] === 'string' && o['userHandle']) || null,
    evmAddress: evm && /^0x[0-9a-f]{40}$/.test(evm) ? evm : null,
    followers: num(o['followers']),
  };
}

/** /v2/leaderboard/24h —— 名次没有字段，靠数组顺序，下标 +1 就是名次 */
export interface LeaderRow extends FomoUser { rank: number; pnl24h: number }

/**
 * 解析结果要能区分**三种**情况，光看 `rows.length` 是分不出来的：
 *   - `shapeOk: true,  rows: [...]` 正常；
 *   - `shapeOk: true,  rows: []`    数据成功但为空（真的没人）；
 *   - `shapeOk: false`              响应结构不对——多半是接口改了，**不能当成「为空」**，
 *                                   更不能据此认为数据源在线。
 */
export interface ParseResult<T> { shapeOk: boolean; rows: T[] }

export function parseLeaderboardResult(json: unknown): ParseResult<LeaderRow> {
  const arr = unwrap(json);
  if (!Array.isArray(arr)) return { shapeOk: false, rows: [] };
  return { shapeOk: true, rows: parseLeaderboard(json) };
}

export function parseHodlersTopResult(json: unknown): ParseResult<TokenHodlers> {
  const arr = unwrap(json);
  if (!Array.isArray(arr)) return { shapeOk: false, rows: [] };
  return { shapeOk: true, rows: parseHodlersTop(json) };
}

export function parseLeaderboard(json: unknown): LeaderRow[] {
  const arr = unwrap(json);
  if (!Array.isArray(arr)) return [];
  const out: LeaderRow[] = [];
  arr.forEach((item, i) => {
    const u = parseUser(item);
    const pnl = num((item as Record<string, unknown>)?.['pnl24h']);
    if (!u || pnl === null) return;
    out.push({ ...u, rank: i + 1, pnl24h: pnl });
  });
  return out;
}

/** /hodlers/top —— responseObject 是数组，每个代币一项 */
export interface TokenHolder {
  rank: number; user: FomoUser;
  amount: number | null; pnl: number | null; isDev: boolean;
}
export interface TokenHodlers {
  ca: string; networkId: number | null;
  fomoHolders: number | null;      // 持有该币的 FOMO 用户数 = 卡片上的「Fomo」
  top: TokenHolder[];
}

export function parseHodlersTop(json: unknown): TokenHodlers[] {
  const arr = unwrap(json);
  if (!Array.isArray(arr)) return [];
  const out: TokenHodlers[] = [];
  for (const entry of arr) {
    const o = entry as Record<string, unknown>;
    const ca = typeof o['tokenAddress'] === 'string' ? o['tokenAddress'].toLowerCase() : null;
    if (!ca) continue;
    const top: TokenHolder[] = [];
    const list = Array.isArray(o['topHolders']) ? (o['topHolders'] as unknown[]) : [];
    list.forEach((h, i) => {
      const ho = h as Record<string, unknown>;
      const u = parseUser(ho['user']);
      if (!u) return;
      top.push({
        rank: i + 1, user: u,
        amount: num(ho['humanAmount']),
        pnl: num(ho['pnl']),
        isDev: ho['isDev'] === true,
      });
    });
    out.push({ ca, networkId: num(o['networkId']), fomoHolders: num(o['totalHolders']), top });
  }
  return out;
}
