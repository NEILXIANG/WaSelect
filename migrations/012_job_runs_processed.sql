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
