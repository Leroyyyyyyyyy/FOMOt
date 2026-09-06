import type { Address } from 'viem';
import { client, blockClock } from '../src/chain/client.js';
import { blockscout } from '../src/chain/blockscout.js';
import { poolManagerAbi, erc20Abi } from '../src/chain/abi.js';
import { chain } from '../src/config.js';
import { splitPair, resolveQuote } from '../src/chain/quotes.js';
import { priceUsd, marketCapUsd, fmtUsd } from '../src/chain/pricing.js';
import { snapshotHolders } from '../src/chain/holders.js';

const latest = await blockClock.sync();
const logs = await client.getLogs({
  address: chain.poolManager, event: poolManagerAbi[0],
  fromBlock: latest - 18000n, toBlock: latest,     // 约 30 分钟
});

let done = 0;
for (const l of logs.reverse()) {
  if (done >= 4) break;
  const a = l.args as any;
  const pair = splitPair(a.currency0, a.currency1);
  if (!pair) continue;
  const quote = await resolveQuote(pair.quote);
  if (!quote) continue;

  let dec = 18, supply = 0n, sym = '?', name = '?';
  try {
    [sym, name, dec, supply] = await Promise.all([
      client.readContract({ address: pair.token, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: pair.token, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: pair.token, abi: erc20Abi, functionName: 'decimals' }).then(Number),
      client.readContract({ address: pair.token, abi: erc20Abi, functionName: 'totalSupply' }),
    ]) as [string, string, number, bigint];
  } catch { continue; }

  const p = priceUsd(BigInt(a.sqrtPriceX96), dec, quote.decimals, pair.tokenIsCurrency0, quote.usdPrice);
  const mc = marketCapUsd(p, supply, dec);

  // 从池子建立前 3000 块开始扫（代币部署总在建池之前一点）
  const snap = await snapshotHolders(pair.token as Address, l.blockNumber - 3000n, latest);
  const bsCount = await blockscout.holdersCount(pair.token);
  const ageMin = Number(latest - l.blockNumber) * chain.blockTimeMs / 60000;

  console.log(
    `\n${sym} (${name})  ${pair.token}\n` +
    `  计价 ${quote.symbol}  价格 $${p.toPrecision(4)}  市值 ${fmtUsd(mc)}  池龄 ${ageMin.toFixed(1)}min\n` +
    `  持币人 自建=${snap.total}  Blockscout=${bsCount ?? 'n/a'}   扫描 ${snap.scannedBlocks} 块 / ${snap.latencyMs}ms\n` +
    `  Top3: ${snap.top.slice(0,3).map(h => `${h.address.slice(0,10)}…=${(Number(h.balance)/10**dec/1e6).toFixed(2)}M`).join('  ')}`,
  );
  done++;
}
