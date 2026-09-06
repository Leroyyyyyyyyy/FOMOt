/**
 * 备用 RPC 候选实测。
 *
 * 重点不是「能连上」，而是「返回的数据和主节点一致」——
 * 一个静默返回不完整日志的节点会让持币人数和成交量直接算错，比没有备用更危险。
 */
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const PRIMARY = 'https://rpc.mainnet.chain.robinhood.com';
const CANDIDATES = [
  PRIMARY,
  'https://robinhood-rpc.publicnode.com',
  'https://rpc.arrowrpc.com',
  'https://rpc.ordofi.network',
  'https://robinhood.api.pocket.network',
  'https://rpc.nodeflare.app/robinhood/public',
  'https://rpc-robinhood.blockmachine.io',
  'https://lb.routeme.sh/rpc/evm/4663',
];
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
// 部署交易（区块 54349310），用来验证历史交易可读——deployment() 的回退路线依赖它
const OLD_TX = '0xc2235db2030db162d157676dc32fd28e209fadb2a4f79149a4f909ec90c066fa';

async function rpc(url: string, method: string, params: unknown[], timeoutMs = 15000) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json() as any;
    return { ms: Date.now() - t0, result: j.result, error: j.error?.message ?? (res.ok ? null : `HTTP ${res.status}`) };
  } catch (e) {
    return { ms: Date.now() - t0, result: null, error: String(e).split('\n')[0]?.slice(0, 60) };
  }
}

const head = await rpc(PRIMARY, 'eth_blockNumber', []);
const TOP = Number(head.result);
const hex = (n: number) => '0x' + n.toString(16);
console.log(`主节点高度 ${TOP}\n`);

// 先用主节点定基准
const baseInit = await rpc(PRIMARY, 'eth_getLogs', [{ address: PM, topics: [INIT_TOPIC], fromBlock: hex(TOP - 2000), toBlock: hex(TOP) }]);
const baseSwap = await rpc(PRIMARY, 'eth_getLogs', [{ address: PM, topics: [SWAP_TOPIC], fromBlock: hex(TOP - 600), toBlock: hex(TOP) }]);
const nInit = (baseInit.result as unknown[] | null)?.length ?? -1;
const nSwap = (baseSwap.result as unknown[] | null)?.length ?? -1;
console.log(`基准：Initialize/2000块 = ${nInit} 条 · Swap/600块 = ${nSwap} 条\n`);

console.log('端点'.padEnd(46), 'chainId  高度差  Init  Swap  历史tx  延迟');
console.log('─'.repeat(100));
for (const url of CANDIDATES) {
  const id = await rpc(url, 'eth_chainId', []);
  if (id.error || Number(id.result) !== 4663) {
    console.log(`${url.padEnd(46)} ❌ ${id.error ?? 'chainId=' + Number(id.result)}`);
    continue;
  }
  const bn = await rpc(url, 'eth_blockNumber', []);
  const lag = TOP - Number(bn.result);
  const li = await rpc(url, 'eth_getLogs', [{ address: PM, topics: [INIT_TOPIC], fromBlock: hex(TOP - 2000), toBlock: hex(TOP) }]);
  const ls = await rpc(url, 'eth_getLogs', [{ address: PM, topics: [SWAP_TOPIC], fromBlock: hex(TOP - 600), toBlock: hex(TOP) }]);
  const tx = await rpc(url, 'eth_getTransactionByHash', [OLD_TX]);

  const ci = li.error ? `ERR` : String((li.result as unknown[]).length);
  const cs = ls.error ? `ERR` : String((ls.result as unknown[]).length);
  const mark = (v: string, base: number) => v === 'ERR' ? '❌' + v : Number(v) === base ? '✅' + v : '⚠️ ' + v;
  const hist = tx.error ? '❌' : (tx.result ? '✅' : '❌空');
  console.log(
    `${url.padEnd(46)} ${String(Number(id.result)).padEnd(8)} ${String(lag).padStart(5)}  ` +
    `${mark(ci, nInit).padEnd(7)} ${mark(cs, nSwap).padEnd(7)} ${hist.padEnd(5)} ${String(id.ms) + 'ms'}`,
  );
}

export {};
