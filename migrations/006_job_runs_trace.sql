-- 006：job_runs 增加 trace_id（F13）。
--
-- @why 定时任务是**跨进程**的：它不跑在任何请求的异步链里，AsyncLocalStorage 拿不到
--      上游上下文，于是它写的每一条日志都没有 trace_id——排查时"这一轮 tick 到底做了什么"
--      只能靠时间戳去猜。context.ts 的 @limitation 一 早就点名了这件事，并写明
--      "由调度方显式把 trace_id 存进任务行再 runWithContext 包一层"，本迁移就是那个"存"的位置。
--
-- @why 存进**表里**而不是只打进日志：看门狗的第一现场是 `job_runs` 那一行
--      （"last_success_at 多久没动了？"）。从那一行能直接拿到 trace_id 跳到这一轮的全部日志，
--      中间不需要"再去日志里搜时间戳"这一步——那是事故当晚最容易做错的一步。
--
-- @why 一轮 tick 一个 trace_id（不是每个子任务一个）：一轮 tick 是**一个操作**，
--      拆成多条链就看不到"同一个 tick 里 A 关了 3 单、B 失败"这个组合事实。
--      取舍见 docs/自主决策记录.md AJ-57。
--
-- @limitation 可空且无索引：它只用于"从心跳行反查日志"，不参与任何查询条件。
--              若将来要做"按 trace_id 追踪跨 tick 的链路"，再评估加索引。
--
-- @see server/src/ports/scheduler.ts（traceId 口径）；server/src/app/scheduler.ts（runWithContext）；
--      server/src/context.ts @limitation 一；docs/自主决策记录.md AJ-57

-- Up migration

ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS trace_id TEXT;

-- Down migration

ALTER TABLE job_runs DROP COLUMN IF EXISTS trace_id;
