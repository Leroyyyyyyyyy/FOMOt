import '../tests/helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HolderScheduler } from '../src/engine/scheduler.js';

const defer = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(r => setImmediate(r));

test('并发上限：最多同时跑两个', async () => {
  const s = new HolderScheduler<any>(2);
  const gates = [defer<number>(), defer<number>(), defer<number>()];
  const started: number[] = [];
  gates.forEach((g, i) => void s.schedule('initial', () => { started.push(i); return g.promise; }));
  await tick();
  assert.deepEqual(started, [0, 1], '第三个必须等着');
  gates[0]!.resolve(0);
  await tick(); await tick();
  assert.deepEqual(started, [0, 1, 2]);
  gates[1]!.resolve(1); gates[2]!.resolve(2);
});

test('初值优先于复核和预热', async () => {
  const s = new HolderScheduler<any>(1);
  const block = defer<number>();
  const order: string[] = [];
  void s.schedule('prewarm', () => { order.push('占位'); return block.promise; });
  await tick();
  // 队列里先排预热、再排复核、最后排初值——出队顺序必须反过来
  void s.schedule('prewarm', async () => { order.push('prewarm'); });
  void s.schedule('recheck', async () => { order.push('recheck'); });
  void s.schedule('initial', async () => { order.push('initial'); });
  block.resolve(0);
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(order, ['占位', 'initial', 'recheck', 'prewarm']);
});

test('每种任务各占各的槽：长预热堵不住复核', async () => {
  // 这是 288 秒复核长尾的整改点：以前复核和预热共用一个「后台槽」，
  // 一个已经开跑的全量预热（老币要从部署区块扫起，几分钟）能把复核堵到它跑完。
  const s = new HolderScheduler<any>(3);
  const slow = defer<number>(), rc = defer<number>();
  const started: string[] = [];
  void s.schedule('prewarm', () => { started.push('prewarm'); return slow.promise; });
  await tick();
  void s.schedule('recheck', () => { started.push('recheck'); return rc.promise; });
  await tick();
  assert.deepEqual(started, ['prewarm', 'recheck'], '预热还在跑，复核照样能起来');

  const init = defer<number>();
  void s.schedule('initial', () => { started.push('init'); return init.promise; });
  await tick();
  assert.deepEqual(started, ['prewarm', 'recheck', 'init'], '初值还有自己的位置');
  slow.resolve(0); rc.resolve(0); init.resolve(0);
});

test('同类任务受各自槽位上限约束，并发不会失控', async () => {
  const s = new HolderScheduler<any>(3);
  const gates = [defer<number>(), defer<number>()];
  const started: string[] = [];
  gates.forEach((g, i) => void s.schedule('prewarm', () => { started.push(`p${i}`); return g.promise; }));
  await tick();
  assert.deepEqual(started, ['p0'], '预热最多同时跑一个');
  assert.equal(s.running, 1);
  gates[0]!.resolve(0);
  await tick(); await tick();
  assert.deepEqual(started, ['p0', 'p1']);
  gates[1]!.resolve(0);
});

test('持续的初值不会让后台任务永久饥饿', async () => {
  const s = new HolderScheduler<any>(2);
  const started: string[] = [];
  void s.schedule('prewarm', async () => { started.push('bg'); });
  for (let i = 0; i < 5; i++) void s.schedule('initial', async () => { started.push('init'); });
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(started.includes('bg'), '后台任务必须被执行到');
  assert.equal(started.filter(x => x === 'init').length, 5);
});

test('收到退出信号后，排队中的任务不再启动新采集', async () => {
  const ac = new AbortController();
  const s = new HolderScheduler<any>(1, ac.signal);
  const block = defer<number>();
  let queuedRan = false;
  void s.schedule('initial', () => block.promise);
  await tick();
  const queued = s.schedule('recheck', async () => { queuedRan = true; return 1; });
  const settled = queued.then(() => 'ok', () => 'rejected');
  ac.abort();
  block.resolve(0);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(await settled, 'rejected');
  assert.equal(queuedRan, false, '中止后不能再启动采集');
});

test('中止后再提交任务直接被拒绝', async () => {
  const ac = new AbortController();
  ac.abort();
  const s = new HolderScheduler<any>(2, ac.signal);
  let ran = false;
  await assert.rejects(() => s.schedule('initial', async () => { ran = true; return 1; }), /已中止/);
  assert.equal(ran, false);
});

test('任务失败不会卡死槽位', async () => {
  const s = new HolderScheduler<any>(1);
  await assert.rejects(() => s.schedule('initial', async () => { throw new Error('炸了'); }), /炸了/);
  assert.equal(await s.schedule('initial', async () => 42), 42);
  await tick();                       // finally 在 resolve 之后才跑，等一拍再看槽位
  assert.equal(s.running, 0);
  assert.equal(s.pending, 0);
});
