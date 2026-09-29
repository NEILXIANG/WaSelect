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
 *
 * @tradeoff 不挂限流：它是带密钥的机器端点，调用频率是天级；攻击面在密钥本身
 *           （32 字节随机），不在频率。真出现被扫的迹象再按 rateLimitRules 表加规则。
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
import { systemClock } from '../adapters/clock.js';
import { systemIdGen } from '../adapters/ids.js';
import { createSchedulerDeps } from './scheduler-start.js';
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
  deps: { config: AppConfig; logger: Logger; db: Db; events: EventBus },
): void {
  app.post(`${INTERNAL_JOBS_PREFIX}/daily`, (req, res, next) => {
    void (async () => {
      try {
        const secret = deps.config.INTERNAL_JOB_SECRET;
        const got = req.header('x-internal-job-secret') ?? '';
        // 先拒没带头的来访者（全量审计 2026-09-26 P2）：这是无鉴权、无限流的公网路径，
        // 若先判"配置缺失"再打 error，任何匿名请求都能刷一条 error 级日志/告警。
        // 带了头、而我们没配密钥，才是配置缺口，此时响亮（文件头 @why ③）。
        if (got.length === 0) throw new AppError(40101);
        if (secret === undefined) {
          deps.logger.error('internal_job_disabled', {
            result: 'refused',
            ctx: { reason: 'INTERNAL_JOB_SECRET 未配置' },
          });
          throw new AppError(50000);
        }
        if (!secretMatches(got, secret)) throw new AppError(40101);

        const runId = systemIdGen.uuid();
        const startedAt = systemClock.now().toISOString();
        // ⚠️ 必 catch：未捕获的 rejection 会被进程级处理器当 fatal（与 scheduler-start.ts 同一条纪律）。
        //    完成与否**不看这个 Promise**——看 `job_runs('daily')` 心跳（D-45）：
        //    那是生产上唯一的可观测出口，也是调用方（cron）事后核实的依据；
        //    刻意不把句柄存在模块里（模块级状态会被同进程的第二个 bootstrap 覆盖，
        //    还容易让人以为"端点只会跑一次"——真正的互斥是调度器的 advisory lock）。
        void runSchedulerOnce(
          createSchedulerDeps(deps.db, deps.events, systemClock, deps.logger, {
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
        });

        res.status(202).json({ run_id: runId, started_at: startedAt });
      } catch (e) {
        next(e);
      }
    })();
  });
}
