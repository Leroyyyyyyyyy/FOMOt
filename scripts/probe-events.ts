import { toEventSelector } from 'viem';
const sigs = [
  'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
  'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
  'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)',
  'Transfer(address,address,address,uint256,uint256)',
  'Donate(bytes32,address,uint256,uint256)',
];
// 上一步从链上实测到的 topic0 → 出现次数
const seen: Record<string, string> = {
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f': '7745 (topics=3 data=6w)',
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec': '1239 (topics=3 data=4w)',
  '0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859': ' 276 (topics=4 data=2w)',
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438': '  18 (topics=4 data=5w)',
  '0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb': '  11 (topics=3 data=2w)',
};
for (const s of sigs) {
  const t = toEventSelector(`event ${s}` as `event ${string}`);
  const hit = seen[t];
  console.log(`${hit ? '✅' : '❌'} ${(s.split('(')[0] ?? '').padEnd(16)} ${t}  ${hit ?? '(未在实测日志中出现)'}`);
}
