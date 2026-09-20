// 进程内的按名互斥：同名任务已在执行时，新来的一次不会并发执行。
// 用于定时触发的周期性任务——上一轮还没跑完，再叠一轮没有意义，只会拖慢其他任务。

export const SKIPPED = Symbol('skipped');

export interface Exclusive {
  /**
   * 执行 fn；同名任务正在执行时不执行，返回 SKIPPED。
   * coalesce：被跳过的这一次不能白白丢掉（如恰好落在新调度时点上的 tick）——让正在执行的那一轮结束后紧接着再跑一遍，多次请求合并为一遍。
   */
  run<T>(name: string, fn: () => Promise<T>, opts?: { coalesce?: boolean }): Promise<T | typeof SKIPPED>;
  isRunning(name: string): boolean;
}

export function createExclusive(): Exclusive {
  const running = new Set<string>();
  const rerun = new Set<string>();
  return {
    isRunning: (name) => running.has(name),
    async run(name, fn, opts) {
      if (running.has(name)) {
        if (opts?.coalesce) rerun.add(name);
        return SKIPPED;
      }
      running.add(name);
      try {
        let result = await fn();
        while (rerun.delete(name)) result = await fn();
        return result;
      } finally {
        running.delete(name);
        rerun.delete(name);
      }
    },
  };
}
