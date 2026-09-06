import { harvest } from '../src/fomo/extract.js';
// 三种常见包装结构，验证提取器不依赖外层形状
const samples = [
  { name: '扁平数组', json: [{ rank: 28, username: 'frank', followers: 218710, pnl24h: 323150.12, wallet: '0x1111111111111111111111111111111111111111' }] },
  { name: '嵌套 data.items', json: { data: { items: [{ position: 118, displayName: 'Albus', follower_count: 2150, realized_pnl: '122860.5', address: { hash: '0x2222222222222222222222222222222222222222' } }] } } },
  { name: '持仓列表', json: { holders: [{ owner: '0x3333333333333333333333333333333333333333', balance: '11020000', user: { handle: 'frank', followers: 218710 } }] } },
  { name: '无关载荷', json: { config: { theme: 'dark', flags: [1, 2, 3] } } },
];
for (const s of samples) {
  const r = harvest(s.json);
  console.log(`${s.name.padEnd(14)} → ${r.length} 条`, r.map(x => `${x.handle ?? '?'}#${x.rank ?? '-'} fans=${x.followers ?? '-'} pnl=${x.pnl24h ?? '-'} ${x.address?.slice(0, 8) ?? '-'}`).join(' | '));
}
