/**
 * 职责：`POST /api/v1/internal/jobs/daily`（I1-U7b，欠账① / D-43 / D-45）——
 *       每日作业的 HTTP 触发端点，Render Cron Job 每天调一次。
 *
 * @why **立即 202、进程内异步执行**（契约原文）：经 Cloudflare 代理有 100 秒上限，
 *      同步跑对账会超时被代理掐断，而调用方会以为"没跑"再调一次。
 *      202 + `job_runs('daily')` 心跳把"已受理"与"跑完没"分开——
 *      跑没跑完看 job_runs，不看响应（D-45）。
 * @why 鉴权是**共享密钥头**（`X-Internal-Job-Secret`，契约 internalSecret）而不是 JWT：
 *      调用方是机器（cron），没有人与角色；密钥比对用 timingSafeEqual（与 pay-link
 *      的 token 比对同一条防线）。
 * @why 未配置 `INTERNAL_JOB_SECRET` 时**挂路由但返回 50000**（不是不挂载）：
 *      404 会把"我们没配密钥"表现成"cron 打错地址"，排查方向整个反掉——
 *      与 wechat_login_not_configured（AJ-113 ④）同一个判断。
 *      ⚠️ 但"没配密钥"这件事**只在装配期记一次**（SEC2-04 / AJ-337），不在每个请求上记：
 *      它曾经是每个带 `X-Internal-Job-Secret` 头的请求都打一条 **error**——
 *      而本路由无鉴权、无限流，任何人加一个任意值的头就能刷满 error 级日志与告警；
 *      告警一旦可以被外人按一下就响，它就会被当成噪声忽略掉。
 *      真正的响亮信号在调用方：render.yaml 的 cron 服务 `r.status !== 202` 就 `process.exit(1)`，
 *      Render 会把它记成一次失败的 cron 运行——那才是"daily 没跑"该响的那一声。
 *
 * @tradeoff 不挂限流：它是带密钥的机器端点，调用频率是天级；攻击面在密钥本身
 *           （32 字节随机），不在频率。真出现被扫的迹象再按 rateLimitRules 表加规则。
 *           ⚠️ 前提（SEC2-04 之后才成立）：每个请求的代价只是一次 `timingSafeEqual`。
 *           曾经每个请求还带一条 error 日志，那条才是"不挂限流"的真正代价——现已摘掉。
 *
 * @see app/daily-reconciliation.ts（作业本体）；config.ts INTERNAL_JOB_SECRET；
 *      docs/I1阶段开发实施方案.md §3.7
 */
import { timingSafeEqual } from 'node:crypto';
import type { Express } from 'express';
import type { Db } from '../adapters/db.js';
import type { EventBus } from '../ports/events.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { systemIdGen } from '../adapters/ids.js';
import type { Clock } from '../ports/clock.js';
import { createSchedulerDeps } from './scheduler-start.js';
import type { InflightJobs } from './inflight-jobs.js';
import { runSchedulerOnce } from './scheduler.js';
import { DAILY_JOB_ROW_NAME } from '../ports/scheduler.js';
import { createDailyReconciliationJob } from './daily-reconciliation.js';
import { createAutoCompleteJob, createAutoDeliverJob } from './auto-fulfilment.js';
import { createCleanupLoginAttemptsJob } from './login-attempts-cleanup.js';

export const INTERNAL_JOBS_PREFIX = '/api/v1/internal/jobs';

/**
 * 比共享密钥（长度不一致也安全：先比长度再走 timingSafeEqual，不借长度差泄露信息——
 * 攻击者本来就知道"密钥是 32 字节以上"这一公开配置口径）。
 */
function secretMatches(got: string, want: string): boolean {
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(want, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mountInternalJobsRoutes(
  app: Express,
  deps: {
    config: AppConfig;
    logger: Logger;
    db: Db;
    events: EventBus;
    /**
     * 时钟（F10）。**必须注入**：`mount.ts` 承诺"测试传 clock ⇒ 全站时间受控"
     * （`MountContext.clock`，生产不传时与 `systemClock` 逐字等价）。
     * 这里曾经**直接 import `systemClock`**，于是注入时钟时全站只有这一条端点
     * 仍在走真实时间：响应里的 `started_at`、以及它拉起的那一整串作业
     * （自动签收 / 自动完成的 `afterDays`、对账的 48h 回看窗口）全都用真钟，
     * 而同一个进程里其它路由用的是注入钟 —— **一半一半，且不报任何错**。
     * 这是 SEC-14 余项里唯一有实际后果的一条（其余的 `Date.now()` 都不进业务判定）。
     */
    clock: Clock;
    /** 在途作业登记表（OPS3-05）：停机会等它跑完再关库。 */
    jobs: InflightJobs;
  },
): void {
  // ── 装配期体检（SEC2-04）："没配密钥"是**配置缺口**，与任何请求都无关 ──
  //    @why 放在这里而不是请求里：本路由无鉴权、无限流，把这条 error/log 留在请求路径上
  //    等于"任何人带一个任意值的头就能按一次告警铃"（详见文件头 @why）。
  //    @why 生产用 error 级：生产上没配 ⇒ daily 作业**永远不会跑**，而它的唯一症状是
  //    "对账异常没人发现"——这是事故，不是提示。非生产（dev/test 常态不配）用 warn，
  //    否则每次本地起服务都报一条 error，反而把真的 error 淹掉。
  if (deps.config.INTERNAL_JOB_SECRET === undefined) {
    const msg = {
      result: 'refused',
      ctx: { reason: 'INTERNAL_JOB_SECRET 未配置，daily 作业不会跑' },
    };
    if (deps.config.NODE_ENV === 'production') deps.logger.error('internal_job_disabled', msg);
    else deps.logger.warn('internal_job_disabled', msg);
  }
  app.post(`${INTERNAL_JOBS_PREFIX}/daily`, (req, res, next) => {
    void (async () => {
      try {
        const secret = deps.config.INTERNAL_JOB_SECRET;
        const got = req.header('x-internal-job-secret') ?? '';
        // 先拒没带头的来访者（全量审计 2026-09-26 P2）：这是无鉴权、无限流的公网路径，
        // 若先判"配置缺失"再打 error，任何匿名请求都能刷一条 error 级日志/告警。
        // ⚠️ 带了头、而我们没配密钥，仍然是 50000（响亮），但**不再逐请求记日志**——
        //    那一条已挪到装配期（见上），否则"加个任意值的头"就能源源不断地制造 error（SEC2-04）。
        if (got.length === 0) throw new AppError(40101);
        if (secret === undefined) throw new AppError(50000);
        if (!secretMatches(got, secret)) throw new AppError(40101);

        // ⚠️ `runId` **刻意**用真 `systemIdGen` 而不是注入的 idGen：它是这一轮作业的**痕踪 id**，
        //    唯一性比可预测性重要——测试注入的 idGen 返回的是**固定**串（如 `stubIdGen('B3AAAA')`），
        //    拿它当 runId 会让两轮作业的 `deps.jobs.run('daily:<同一个 id>')` **撞键**。
        //    而时钟必须注入（见 deps.clock 的 @why）：时钟决定作业**跑什么**（到期判定），
        //    idGen 只决定**叫什么**。
        const runId = systemIdGen.uuid();
        const startedAt = deps.clock.now().toISOString();
        // ⚠️ 必 catch：未捕获的 rejection 会被进程级处理器当 fatal（与 scheduler-start.ts 同一条纪律）。
        //    完成与否**不看这个 Promise**——看 `job_runs('daily')` 心跳（D-45）：
        //    那是生产上唯一的可观测出口，也是调用方（cron）事后核实的依据。
        // ⚠️ 但句柄**必须交出去**：登记到 `deps.jobs`（OPS3-05），停机时由它等到跑完。
        //    刻意不把句柄存在**模块级变量**里（会被同进程的第二个 bootstrap 覆盖，
        //    还容易让人以为"端点只会跑一次"——真正的互斥是调度器的 advisory lock）；
        //    登记表是装配期传入的实例，谁等它、等几个，都是看得见的装配关系。
        void deps.jobs.run(
          `daily:${runId}`,
          runSchedulerOnce(
            createSchedulerDeps(deps.db, deps.events, deps.clock, deps.logger, {
              // ⚠️ 名字与看门狗盯的那一行是**同一个常量**：两处字面量各自漂移时，
              //    daily-reconciliation 的 `scanStalledHeartbeats` 会去盯一个不存在的行
              name: DAILY_JOB_ROW_NAME,
              lockKey: 'daily',
            }),
            // 顺序即执行顺序：先把到期的单迁走（自动签收 → 自动完成，O-12 / AJ-182），对账看到的是迁移后的状态；
            // 登录尝试行的清理放最后——它只删"已解锁且过期"的行，不参与任何业务判定，放前面只会拖长锁的持有时间
            [
              createAutoDeliverJob({ afterDays: deps.config.AUTO_DELIVER_DAYS }),
              createAutoCompleteJob({ afterDays: deps.config.AUTO_COMPLETE_DAYS }),
              createDailyReconciliationJob(),
              createCleanupLoginAttemptsJob(),
            ],
          ).catch((e: unknown) => {
            deps.logger.error('internal_job_crashed', {
              result: 'error',
              err: e,
              ctx: { run_id: runId },
            });
          }),
        );

        res.status(202).json({ run_id: runId, started_at: startedAt });
      } catch (e) {
        next(e);
      }
    })();
  });
}
