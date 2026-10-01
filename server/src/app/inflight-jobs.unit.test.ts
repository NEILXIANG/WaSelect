/**
 * 职责：**在途作业登记表**的用例（OPS3-05）。
 *
 * @why 它只有几十行，但"停机等不到"的失效形态是**静默**的：登记表里少一个作业，
 *      门是绿的、日志是正常的，只有"已过期的单还能被付款"这种隔天才显现的现象能暴露它。
 *      所以要钉的是三件会静默失效的事：
 *      ① 失败/成功的作业都**必须**从表里摘掉（留着会让 `wait()` 白等到超时）；
 *      ② `wait()` 只等"调用那一刻已在途"的（否则变成无界等待）；
 *      ③ 超时**不取消**作业，只是不再等（取消一个跑到一半的对账更难善后）。
 */
import { describe, expect, it } from 'vitest';
import { createInflightJobs } from './inflight-jobs.js';

/** 一个可控的 Promise：用例自己决定它何时结束。 */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('登记表', () => {
  it('🔴 作业**失败**也必须摘掉登记：`wait()` 不能一直等一个早已结束的 Promise', async () => {
    const jobs = createInflightJobs();
    const d = deferred();
    const p = jobs.run('daily:1', d.promise);
    expect(jobs.pending).toBe(1);

    d.reject(new Error('对账炸了'));
    await expect(p).rejects.toThrow(/对账炸了/); // 登记处已接住 ⇒ 不会变成 unhandledRejection

    expect(jobs.pending).toBe(0);
    await expect(jobs.wait(50)).resolves.toEqual({ settled: true, pending: 0 });
  });

  it('成功结束同样摘掉登记', async () => {
    const jobs = createInflightJobs();
    const d = deferred<string>();
    void jobs.run('daily:2', d.promise);
    d.resolve('ok');
    await jobs.wait(50);
    expect(jobs.pending).toBe(0);
  });

  it('🔴 没有在途作业时 `wait()` 立即返回（不该白耗停机时间）', async () => {
    const jobs = createInflightJobs();
    await expect(jobs.wait(1_000)).resolves.toEqual({ settled: true, pending: 0 });
  });

  it('🔴 预算 ≤ 0 = 一个都不等，只回报在途数量（"明确不想等"与"等超时"要能区分）', async () => {
    const jobs = createInflightJobs();
    const d = deferred();
    void jobs.run('daily:3', d.promise);
    await expect(jobs.wait(0)).resolves.toEqual({ settled: false, pending: 1 });
    d.resolve();
  });

  it('🔴 等到预算用尽仍未跑完 → settled=false 且报出在途数（超时不取消作业）', async () => {
    const jobs = createInflightJobs();
    const d = deferred();
    void jobs.run('daily:4', d.promise);
    await expect(jobs.wait(20)).resolves.toEqual({ settled: false, pending: 1 });
    // 作业仍在途（没被取消）：它自己的心跳与幂等负责善后
    expect(jobs.pending).toBe(1);
    d.resolve();
  });

  it('🔴 `wait()` 只等调用那一刻已在途的：之后新登记的不再等（否则是无界等待）', async () => {
    const jobs = createInflightJobs();
    const first = deferred();
    void jobs.run('daily:5', first.promise);

    const waiting = jobs.wait(50);
    void jobs.run('daily:6', deferred().promise); // 等的过程中又来一个
    first.resolve();
    await expect(waiting).resolves.toEqual({ settled: true, pending: 0 });
    expect(jobs.pending).toBe(1); // 后登记的那个仍在途——它归下一次 wait / 停机总预算管
  });
});
