import { log } from '../logger.js';

/**
 * RPC 对 eth_getLogs 的限制是「单次命中日志 ≤ 10000 条」，跟区块范围无关。
 * viem 把这个错误显示成 "Missing or invalid parameters"，真实报文是
 * {code:-32000, message:"logs matched by query exceeds limit of 10000"}。
 *
 * 日志密度随代币热度剧烈波动（冷门币几条/块，热门币几百条/块），
 * 所以固定分块必然会在某些币上翻车——只能自适应：撞上限就减半，顺利就缓慢涨回去。
 */
export class AdaptiveRange {
  constructor(private cur: bigint, private readonly min: bigint, private readonly max: bigint, private readonly label = '') {}

  get value(): bigint { return this.cur }

  grow(): void {
    const n = this.cur * 5n / 4n + 1n;
    this.cur = n > this.max ? this.max : n;
  }

  /** 返回 false 表示已经缩到最小还是失败，那就是别的问题，往上抛。 */
  shrink(): boolean {
    if (this.cur <= this.min) return false;
    const n = this.cur / 2n;
    this.cur = n < this.min ? this.min : n;
    log.debug({ label: this.label, range: Number(this.cur) }, '命中日志上限，缩小扫描范围');
    return true;
  }
}

/**
 * 判断是不是「单次查询命中日志过多」。
 *
 * 只匹配报文文本，**不要匹配错误码 -32000**：withRetry 的标签里带着区块范围
 * （形如 `getLogs Swap 31401-32000 重试…`），一个以 32000 开头的区块号会让
 * 普通网络错误被误判成超限，于是缩范围而不是把真实故障报出来。
 */
export const isLogLimitError = (e: unknown): boolean =>
  /exceeds limit|logs matched by query|Missing or invalid parameters|Invalid parameters were provided|ResponseBodyTooLargeError|response body exceeded/i
    .test(String(e));

/** 按自适应范围切片扫完 [from, to]，逐片调用 fetch。 */
export async function scanRange<T>(
  range: AdaptiveRange,
  from: bigint,
  to: bigint,
  fetch: (lo: bigint, hi: bigint) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let lo = from;
  while (lo <= to) {
    const span = range.value;
    const hi = lo + span - 1n > to ? to : lo + span - 1n;
    try {
      out.push(...(await fetch(lo, hi)));
      lo = hi + 1n;
      range.grow();
    } catch (err) {
      if (!isLogLimitError(err) || !range.shrink()) throw err;
    }
  }
  return out;
}
