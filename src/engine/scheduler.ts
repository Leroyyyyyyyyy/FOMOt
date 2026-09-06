/**
 * 持币快照的调度器。
 *
 * 公共 RPC 承受不了重启后多条复核同时全量扫 Transfer，所以最多跑两个快照，
 * 且**后台**任务（复核/预热）只占一个槽，另一个永远留给实时初值。
 * 排队顺序：初值 > 复核 > 预热。
 *
 * 单独拆出来是为了能直接测：优先级、并发上限、取消、后台不饿死。
 */
export type HolderKind = 'initial' | 'recheck' | 'prewarm';

interface Task<T> {
  kind: HolderKind; seq: number;
  run: () => Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void;
}

const PRIORITY: Record<HolderKind, number> = { initial: 0, recheck: 1, prewarm: 2 };

export class HolderScheduler<T = unknown> {
  private queue: Task<T>[] = [];
  private seq = 0;
  private active = 0;
  private backgroundActive = 0;

  constructor(private readonly maxActive = 2, private readonly signal?: AbortSignal) {}

  get pending(): number { return this.queue.length }
  get running(): number { return this.active }

  schedule(kind: HolderKind, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.signal?.aborted) { reject(new Error('已中止')); return; }
      this.queue.push({ kind, seq: this.seq++, run, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    // 收到退出信号后，排队中的任务一律不再启动新采集。
    if (this.signal?.aborted) {
      for (const t of this.queue.splice(0)) t.reject(new Error('已中止，不再启动新采集'));
      return;
    }
    this.queue.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.seq - b.seq);
    while (this.active < this.maxActive && this.queue.length) {
      // 后台任务只能占一个槽；但只要没有后台任务在跑，队首的后台任务就能起来，
      // 所以后台不会被源源不断的初值永久饿死。
      const idx = this.queue.findIndex(t => t.kind === 'initial' || this.backgroundActive === 0);
      if (idx < 0) return;
      const task = this.queue.splice(idx, 1)[0]!;
      const background = task.kind !== 'initial';
      this.active++;
      if (background) this.backgroundActive++;
      void task.run().then(task.resolve, task.reject).finally(() => {
        this.active--;
        if (background) this.backgroundActive--;
        this.pump();
      });
    }
  }
}
