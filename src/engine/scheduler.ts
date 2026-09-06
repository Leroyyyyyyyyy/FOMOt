import { recordMetric } from '../db.js';

/**
 * 持币快照的调度器。
 *
 * 公共 RPC 承受不了重启后多条任务同时全量扫 Transfer，所以有**全局并发上限**，
 * 并且按任务类型分别设槽位上限。
 *
 * 为什么不再用「后台任务共用一个槽」：实跑抓到过一条晚 288 秒的复核，
 * 当时的推断是复核被一个已经开跑的 `prewarm`（老币要从部署区块全量扫，几分钟起步）
 * 堵在后面。推断当时没有证据，现在两件事一起做：
 *   1. `recheck` 和 `prewarm` **各占各的槽**，一个长预热不再能堵住复核；
 *   2. 排队等待与任务执行分开计量，长尾到底是排队还是采集慢，有数可查。
 *
 * 上限是明确的：默认全局 3，其中初值最多 2、复核 1、预热 1。
 * 不是「把并发调大」——那会让 RPC 和内存失控。
 */
export type HolderKind = 'initial' | 'recheck' | 'prewarm';

interface Task<T> {
  kind: HolderKind; seq: number; enqueuedTs: number;
  run: () => Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void;
}

const PRIORITY: Record<HolderKind, number> = { initial: 0, recheck: 1, prewarm: 2 };
export const DEFAULT_SLOTS: Record<HolderKind, number> = { initial: 2, recheck: 1, prewarm: 1 };

export class HolderScheduler<T = unknown> {
  private queue: Task<T>[] = [];
  private seq = 0;
  private active = 0;
  private activeByKind: Record<HolderKind, number> = { initial: 0, recheck: 0, prewarm: 0 };

  constructor(
    private readonly maxActive = 3,
    private readonly signal?: AbortSignal,
    private readonly slots: Record<HolderKind, number> = DEFAULT_SLOTS,
  ) {}

  get pending(): number { return this.queue.length }
  get running(): number { return this.active }

  /** 分类型的排队深度，供心跳与验收报告使用。 */
  depth(): { pending: number; active: number; byKind: Record<HolderKind, number> } {
    return { pending: this.queue.length, active: this.active, byKind: { ...this.activeByKind } };
  }

  schedule(kind: HolderKind, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.signal?.aborted) { reject(new Error('已中止')); return; }
      this.queue.push({ kind, seq: this.seq++, enqueuedTs: Date.now(), run, resolve, reject });
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
      // 每种任务只在自己的槽位没占满时才起来：一个长预热堵不住复核，
      // 复核也抢不走留给实时初值的位置。
      const idx = this.queue.findIndex(t => this.activeByKind[t.kind] < this.slots[t.kind]);
      if (idx < 0) return;
      const task = this.queue.splice(idx, 1)[0]!;
      this.active++;
      this.activeByKind[task.kind]++;
      recordMetric('holder_queue_wait_ms', Date.now() - task.enqueuedTs, task.kind);
      const t0 = Date.now();
      void task.run().then(task.resolve, task.reject).finally(() => {
        recordMetric('holder_run_ms', Date.now() - t0, task.kind);
        this.active--;
        this.activeByKind[task.kind]--;
        this.pump();
      });
    }
  }
}
