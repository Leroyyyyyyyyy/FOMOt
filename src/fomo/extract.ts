/**
 * 形状启发式提取器。
 *
 * prod-api.fomo.family 未鉴权直接返回 430，所以拿不到接口文档，也就没法硬编码字段路径。
 * 这里改成走另一条路：在浏览器里拦下所有 prod-api 的 JSON 响应，递归遍历，
 * 把「看起来像用户/榜单条目」的对象捞出来——只认字段语义，不认接口结构。
 * 接口改版换了包装层也不会失效。
 */

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

const KEY = {
  address: /^(wallet|address|wallet_?address|evm_?address|owner|account|holder)(_?hash)?$/i,
  handle: /^(username|handle|display_?name|nickname|screen_?name|user_?name)$/i,
  followers: /^(followers|follower_?count|followers_?count|num_?followers)$/i,
  pnl: /^(pnl|pnl_?24h|pnl_?usd|realized_?pnl|total_?pnl|profit|profit_?usd|pnl_?1d)$/i,
  rank: /^(rank|position|leaderboard_?rank|placement)$/i,
  userId: /^(id|user_?id|uid|fid)$/i,
  balance: /^(balance|amount|token_?balance|quantity|holding|value)$/i,
};

function pick(obj: Record<string, unknown>, re: RegExp): unknown {
  for (const [k, v] of Object.entries(obj)) if (re.test(k)) return v;
  return undefined;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const n = Number(v.replace(/[$,+\s]/g, '')); if (Number.isFinite(n)) return n; }
  return null;
}

function asAddress(v: unknown): string | null {
  if (typeof v === 'string' && ADDR_RE.test(v)) return v.toLowerCase();
  if (v && typeof v === 'object') {
    const h = (v as any).hash ?? (v as any).address;
    if (typeof h === 'string' && ADDR_RE.test(h)) return h.toLowerCase();
  }
  return null;
}

export interface Record_ {
  address: string | null;
  userId: string | null;
  handle: string | null;
  followers: number | null;
  pnl24h: number | null;
  rank: number | null;
  balance: number | null;
}

/**
 * 持仓列表常见形状是 { owner: "0x..", balance: "..", user: { handle, followers } }——
 * 地址在外层、身份在内层。先把一层内的子对象并进来，避免拆成两条互不相干的记录。
 */
function flattenOneLevel(o: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...o };
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (!/^(user|profile|account|trader|owner|holder|meta)$/i.test(k)) continue;
    for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
      if (!(k2 in merged)) merged[k2] = v2;
    }
  }
  return merged;
}

function toRecord(raw: Record<string, unknown>): Record_ | null {
  const o = flattenOneLevel(raw);
  const address = asAddress(pick(o, KEY.address)) ?? asAddress(o['address']) ?? null;
  const handleRaw = pick(o, KEY.handle);
  const handle = typeof handleRaw === 'string' && handleRaw.length > 0 && handleRaw.length < 64 ? handleRaw : null;
  const followers = asNumber(pick(o, KEY.followers));
  const pnl24h = asNumber(pick(o, KEY.pnl));
  const rank = asNumber(pick(o, KEY.rank));
  const balance = asNumber(pick(o, KEY.balance));
  const idRaw = pick(o, KEY.userId);
  const userId = typeof idRaw === 'string' || typeof idRaw === 'number' ? String(idRaw) : null;

  // 至少要有身份（地址或昵称），再加一条社交/业绩信号，才算一条有用记录
  const hasIdentity = Boolean(address || handle);
  const hasSignal = followers !== null || pnl24h !== null || rank !== null || balance !== null;
  if (!hasIdentity || !hasSignal) return null;
  return { address, userId, handle, followers, pnl24h, rank, balance };
}

/** 递归遍历任意 JSON，捞出所有像「用户记录」的对象。 */
export function harvest(json: unknown, depth = 0, out: Record_[] = []): Record_[] {
  if (depth > 8 || out.length > 5000) return out;
  if (Array.isArray(json)) {
    for (const x of json) harvest(x, depth + 1, out);
  } else if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const rec = toRecord(obj);
    if (rec) out.push(rec);
    for (const [k, v] of Object.entries(obj)) {
      // 已经并进父记录的身份子对象就别再单独走一遍了
      if (rec && /^(user|profile|account|trader|owner|holder|meta)$/i.test(k)) continue;
      if (v && typeof v === 'object') harvest(v, depth + 1, out);
    }
  }
  return out;
}
