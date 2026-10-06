-- 028：每日对账结果落库（剩余清单 3-2：管理端"运营日志"页要能看到最近一次对账）。
--
-- @why 对账结果此前只进日志（daily-reconciliation.ts），管理端拿不到；运营要看"昨天对账有没有异常"
--      只能去翻日志平台——没人会去翻。落一行，页面直接读最近一次。
-- @why 每跑一次**追加**一行而不是覆盖 job_runs 的某列：一天被手动重跑几次时，"上一次说有 3 单、这一次说 0 单"
--      本身就是排查线索；覆盖会把它抹掉。append-only 触发器与 order_events / admin_audit 同一口径。
-- @why counts / samples 用 JSONB：异常类别由 job 代码登记（六类，将来会加），用列会让每加一类就要一次迁移。
-- @limitation 不设保留期：一天一行，十年三千多行，可忽略。
-- @limitation samples 里是订单 / 回调 / 心跳的 id（≤20 条一类），不含 PII。
--
-- @see server/src/app/daily-reconciliation.ts（写入）；server/src/app/admin-ops-log-routes.ts（读出）

-- Up migration

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id       BIGSERIAL PRIMARY KEY,
  ran_at   TIMESTAMPTZ NOT NULL,
  counts   JSONB NOT NULL,
  samples  JSONB NOT NULL,
  trace_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_ran_at ON reconciliation_runs (ran_at DESC);

CREATE TRIGGER trg_reconciliation_runs_append_only
  BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION deny_audit_modification();

-- Down migration

DROP TRIGGER IF EXISTS trg_reconciliation_runs_append_only ON reconciliation_runs;
DROP TABLE IF EXISTS reconciliation_runs;
