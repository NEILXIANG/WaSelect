/**
 * 职责：**在途后台作业的登记表**（OPS3-05）。
 *
 * @why 停机流原本只等两样东西：在途 HTTP 请求（`server.close` 的排空）与
 *      已 publish 的领域事件（`drainEventsThenClose`）。但有两类动作**两样都不算**：
 *      ① 调度器 tick（不是请求）；② `POST /internal/jobs/daily` 202 之后在
 *      进程里继续跑的每日作业（请求早就结束了）。
 *      一轮在途 tick 若在 drain 返回 0 **之后**才提交，它 emit 的 `order.expired`
 *      会在 `closeDb` 之后才分发——`close-session-events` 拿到的连接池已关闭，
 *      机构会话没被作废 ⇒ 已过期的单在会话自然过期前仍可付款 ⇒ `late_payment` ⇒ 人工退款。
 *      "关库前把该做的做完"这件事必须有一个地方知道"还有谁在跑"，登记表就是那个地方。
 *
 * @why 做成**显式传入的实例**而不是模块级单例：模块级状态会被同进程的第二个
 *      bootstrap 覆盖（`internal-jobs-routes.ts` 的同一条纪律），
 *      更根本的是——"谁在等这些作业"必须是**看得见的装配关系**，
 *      隐式单例会让停机流看起来在等，实际等的是另一个实例。
 *
 * @limitation 一：只登记**调用方主动交给它**的 Promise，不做全局拦截。
 *      @why 拦截一切异步动作需要 monkey-patch，那会把"关不掉"变成"关得掉但没人知道为什么"；
 *      登记表要的是"后台作业的作者显式申报"，漏报在评审里看得见，误拦看不见。
 * @limitation 二：`wait()` 只等**调用那一刻已在途**的作业，之后新登记的不再等。
 *      @why 否则"一边等一边有新的进来"会变成无界等待；停机总预算才是那道闸
 *      （`SHUTDOWN_TOTAL_BUDGET_MS`），这里不重复造。
 * @limitation 三：超时**不取消**作业，只是不再等。
 *      @why 取消一个跑到一半的对账作业，后果（半截的 `job_runs` 心跳 + 脏的对账口径）
 *      比"被停机打断"更难判断；作业本身的幂等与心跳负责善后。
 *
 * @see docs/自主决策记录.md AJ-267（为什么是"装配期传入的显式登记表"）；
 *      main.ts（唯一的等待方：`afterDrain`）；ports/scheduler.ts（作业的心跳契约）
 */
export interface InflightWait {
  /** 等到点前是否全部跑完。 */
  settled: boolean;
  /** 到点仍在途的作业数（进日志：排障要能回答"到底卡了几个"）。 */
  pending: number;
}

export interface InflightJobs {
  /** 当前在途数量。 */
  readonly pending: number;
  /**
   * 登记一个在途作业，并**原样返回**它的 Promise（方便调用方自己 await）。
   * @why 成败都摘掉登记：失败的作业若留在表里，`wait()` 会一直等一个早已结束的 Promise。
   */
  run<T>(label: string, p: Promise<T>): Promise<T>;
  /**
   * 等在途作业，至多 `budgetMs` 毫秒。
   * @param budgetMs ≤ 0 = **一个都不等**（只回报在途数量）——测试与"明确不想等"用。
   */
  wait(budgetMs: number): Promise<InflightWait>;
}

/** 只用来做超时竞速的定时器（`unref`：它不该让进程活着）。 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

interface Entry {
  readonly label: string;
  readonly promise: Promise<unknown>;
  done: boolean;
}

export function createInflightJobs(): InflightJobs {
  const entries = new Set<Entry>();

  const countPending = (): number => {
    let n = 0;
    for (const e of entries) if (!e.done) n += 1;
    return n;
  };

  return {
    get pending(): number {
      return countPending();
    },

    run<T>(label: string, p: Promise<T>): Promise<T> {
      const entry: Entry = { label, promise: p, done: false };
      entries.add(entry);
      const finish = (): void => {
        entry.done = true;
        entries.delete(entry);
      };
      // ⚠️ 两个回调都要给：只给 onFulfilled 时，失败的作业既不会摘登记，
      //    它的 rejection 也会因为"没人接"变成 unhandledRejection（进程级 fatal）。
      void p.then(finish, finish);
      return p;
    },

    async wait(budgetMs: number): Promise<InflightWait> {
      // 快照：等的是"此刻已在途"的这些（@limitation 二）
      const snapshot = [...entries];
      if (snapshot.length === 0) return { settled: true, pending: 0 };
      const pendingNow = (): number => snapshot.filter((e) => !e.done).length;
      if (budgetMs <= 0) return { settled: false, pending: pendingNow() };

      // ⚠️ `allSettled` 而不是 `all`：作业失败不等于"没跑完"，它只是失败了；
      //    用 `all` 会让第一个失败直接跳过剩下那几个，而它们的善后（关会话等）还没做完。
      await Promise.race([
        Promise.allSettled(snapshot.map((e) => e.promise)).then(() => undefined),
        delay(budgetMs),
      ]);
      const pending = pendingNow();
      return { settled: pending === 0, pending };
    },
  };
}
