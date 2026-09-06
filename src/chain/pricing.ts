/**
 * Uniswap V4 定价。sqrtPriceX96 编码的是 sqrt(amount1_raw / amount0_raw)。
 *
 *   P_raw         = (sqrtPriceX96 / 2^96)^2          // token1 原始单位 / token0 原始单位
 *   price0_in_1   = P_raw * 10^(d0 - d1)             // 换算成人类单位
 *   price1_in_0   = 1 / price0_in_1
 *
 * 用浮点算：sqrtPriceX96 最大约 2^160，转 Number 有约 16 位有效数字的相对精度，
 * 对 1e-15 量级的 meme 币价格绰绰有余，比 BigInt 定点缩放省事且不会下溢。
 */
export function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
  tokenIsCurrency0: boolean,
): number {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  const pRaw = sqrt * sqrt;
  const price0In1 = pRaw * 10 ** (decimals0 - decimals1);
  const p = tokenIsCurrency0 ? price0In1 : 1 / price0In1;
  return Number.isFinite(p) ? p : 0;
}

/** 代币的美元价 = 以计价资产计的价格 × 计价资产美元价。 */
export function priceUsd(
  sqrtPriceX96: bigint,
  tokenDecimals: number,
  quoteDecimals: number,
  tokenIsCurrency0: boolean,
  quoteUsdPrice: number,
): number {
  const [d0, d1] = tokenIsCurrency0
    ? [tokenDecimals, quoteDecimals]
    : [quoteDecimals, tokenDecimals];
  return priceFromSqrtX96(sqrtPriceX96, d0, d1, tokenIsCurrency0) * quoteUsdPrice;
}

export function marketCapUsd(priceUsd: number, totalSupply: bigint, decimals: number): number {
  return priceUsd * (Number(totalSupply) / 10 ** decimals);
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/** 计数类（粉丝数等）不该出现小数：230 而不是 230.00 */
export function fmtCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(Math.round(n));
}

export function fmtAmount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}
