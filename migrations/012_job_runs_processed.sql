-- 012：`job_runs.last_processed`——把"这一轮处理了多少条"写进心跳行。
--
-- @why 此前 `processed` 只活在**日志**里（`scheduler_tick_done` 的 ctx）：心跳行只能回答
--      "跑没跑完"，回答不了"跑出了什么"。对账 job 尤其致命——它扫描出的异常条数（三类
--      账务异常的计数）是它唯一的产出，却只进日志；看门狗盯着 `job_runs` 那一行
--      **看不见异常，只看得见"它成功跑完了"**（异常 = job 成功 + 结果是"有问题"）。
--      加这一列之后，"看一眼 job_runs"同时得到两件事：跑没跑 + 扫出几条。
-- @why 用 `integer` 且允许 NULL：NULL = 本轮没上报（历史行/未改动的 job），
--      与"处理了 0 条"必须可区分——把 NULL 当 0 会让"没上报"伪装成"没有问题"。
--      ⚠️ 对账 job 的语义要盯住：`last_processed = 0` 是**好消息**（无异常），
--      `last_processed > 0` 才是要人去看的——这一列**不是**错误计数，别写成 last_error。
--
-- ⚠️ 0.6.27（AJ-320）订正：**上面那条"0 好 / >0 该看"的读法，对本表现有的两行都不成立**，
--    本迁移原文把它写成了通用口径，是错的——按它设阈值告警会在正常运营时天天报警。
--    @why 原因不是"语义因 job 而异"，而是**这两行都是多 job 一轮、写的是跨 job 求和**：
--         · tick 一轮三个 job = 关掉的单数 + 删掉的幂等行数 + 看门狗的 0/1 停跑标志；
--         · daily 一轮四个 job = 自动签收数 + 自动完成数 + 对账异常数 + 登录尝试清理数。
--         量纲不同，`ports/scheduler.ts` @limitation 二 因此写明"跨 job 求和没有意义"。
--         它骗人的**方向最坏**：daily 停跑在和里只贡献 **1**（看着最无害），
--         而每天自动签收几十单贡献几十（看着最像异常）。
--    @why **保留写入、只订正读法**（不是撤掉这一列）：它今天在事实上承担了
--         "本轮跑完了"的表内标记——`internal-jobs.db.test` 就是拿它当等待判据
--         （`last_success_at` 被基线预置成健康值，等它出现会等到基线而不是本轮）。
--         撤掉它等于改那条 db 用例的判据（换 `trace_id` / `updated_at`，基线同步清），
--         属另一处改动，不混进本轮做；已登记为**未做的正解**。
--    @limitation 于是"看一眼 job_runs 就知道扫出几条异常"这件事今天**做不到**：
--               对账的异常分类计数只在 `daily-reconciliation` 的汇总日志里，
--               tick 每个 job 各多少在 `scheduler_tick_done` 的 `processed_by_job` 里
--               （0.6.27 起按 job 名分别给，不再只给一个求和值）。
--               要"看表即知"需另立项：每 job 一行心跳，或给这一行加一列只对账数。
--
-- @limitation 本列只承载**条数**，不承载明细（明细在日志，靠 trace_id 反查）。
--              把 id 清单塞进表里会让心跳行变成不定长的垃圾场，且没有检索价值。
--
-- @see migrations/001_init.sql（job_runs 表与 seed）；006（trace_id 列，同一条"看门狗第一现场
--      在表里不在日志里"的理由）；server/src/adapters/scheduler.ts（写入）；
--      docs/复盘与自我审计报告-2026-09-26.md（R-b）

-- Up migration

ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS last_processed integer;

-- Down migration

ALTER TABLE job_runs DROP COLUMN IF EXISTS last_processed;
