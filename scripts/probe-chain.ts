import { parseAbiItem, decodeEventLog, formatUnits } from 'viem';
import { client, blockClock } from '../src/chain/client.js';
import { blockscout } from '../src/chain/blockscout.js';
import { poolManagerAbi, erc20Abi } from '../src/chain/abi.js';
import { chain } from '../src/config.js';

const eth = await blockscout.ethPrice();
console.log('ETH price   =', eth);
const t = await blockscout.tokenInfo('0x385f4f8ae47651ce5f58f5265395a669f8281e18');
console.log('MEME token  =', t?.name, `(${t?.symbol})`, 'holders', t?.holders_count, 'mc', t?.circulating_market_cap);

const latest = await blockClock.sync();
console.log('latest block=', latest);

// 最近 ~3000 块（约 5 分钟）里新建的池子
const logs = await client.getLogs({
  address: chain.poolManager,
  event: poolManagerAbi[0],
  fromBlock: latest - 3000n,
  toBlock: latest,
});
console.log(`\n最近 5 分钟新池: ${logs.length} 个\n`);

for (const l of logs.slice(-6)) {
  const { currency0, currency1, fee, hooks, sqrtPriceX96 } = l.args as any;
  const ZERO = '0x0000000000000000000000000000000000000000';
  const tokenIs1 = currency0.toLowerCase() === ZERO;
  const ca = tokenIs1 ? currency1 : currency0;
  const quote = tokenIs1 ? currency0 : currency1;

  let meta = { symbol: '?', name: '?', decimals: 18, totalSupply: 0n };
  try {
    const [symbol, name, decimals, totalSupply] = await Promise.all([
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: ca, abi: erc20Abi, functionName: 'totalSupply' }),
    ]);
    meta = { symbol, name, decimals: Number(decimals), totalSupply };
  } catch { /* 非标准代币 */ }

  // sqrtPriceX96^2 / 2^192 = 原始价 (token1_raw per token0_raw)
  const Q192 = 2n ** 192n;
  const raw = Number((BigInt(sqrtPriceX96) ** 2n * 10n ** 18n) / Q192) / 1e18;
  // 代币是 currency1、quote 是 18 位原生币时：1 代币 = 1/raw 个 ETH
  const priceEth = tokenIs1 ? 1 / raw : raw;
  const priceUsd = priceEth * eth;
  const mcap = priceUsd * Number(formatUnits(meta.totalSupply, meta.decimals));

  console.log(
    `${meta.symbol.padEnd(10)} ${meta.name.slice(0, 22).padEnd(24)} ca=${ca}\n` +
    `   quote=${quote === ZERO ? 'NATIVE ETH' : quote}  fee=${fee}  hooks=${hooks}\n` +
    `   price=$${priceUsd.toPrecision(4)}  MC=$${(mcap / 1000).toFixed(2)}K  block=${l.blockNumber}`,
  );
}
