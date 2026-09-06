import type { HolderSnapshot } from '../../src/chain/holders.js';
import type { FomoTokenStats, FomoTopHolder, FomoLeader } from '../../src/fomo/provider.js';

export const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;

export function snapshot(over: Partial<HolderSnapshot> = {}): HolderSnapshot {
  const top = Array.from({ length: 10 }, (_, i) => ({ address: addr(i + 1), balance: BigInt(100 - i) * 10n ** 18n }));
  return {
    ca: addr(999), total: 20, top, balances: new Map(top.map(h => [h.address, h.balance])),
    atBlock: 100n, atBlockHash: '0xhash', blockTs: 1_700_000_000_000, takenTs: Date.now(),
    scannedBlocks: 1, rebuilt: false, latencyMs: 1, ...over,
  };
}

/** 可写余额表的快照——测试要往里塞地址 */
export function mutableSnapshot(over: Partial<HolderSnapshot> = {}) {
  const s = snapshot(over);
  const balances = new Map(s.balances);
  return { snap: { ...s, balances } as HolderSnapshot, balances };
}

export function holder(i: number, over: Partial<FomoTopHolder> = {}): FomoTopHolder {
  return { rank: i + 1, userId: `u${i}`, handle: `u${i}`, evmAddress: addr(i + 101),
    followers: 1, amount: 100 - i, pnl: 1, isDev: false, ...over };
}

export function stats(top: FomoTopHolder[], over: Partial<FomoTokenStats> = {}): FomoTokenStats {
  return { fomoHolders: 20, freshMs: 0, takenTs: Date.now(), ingestMs: 2, top, ...over };
}

export function statsFromPnls(pnls: (number | null)[], over: Partial<FomoTokenStats> = {}): FomoTokenStats {
  return stats(pnls.map((pnl, i) => holder(i, { pnl })), over);
}

export function leader(over: Partial<FomoLeader> = {}): FomoLeader {
  return { rank: 1, userId: 'lb1', handle: 'lb1', evmAddress: addr(500),
    followers: 10, pnl24h: 100, updatedTs: Date.now(), ...over };
}
