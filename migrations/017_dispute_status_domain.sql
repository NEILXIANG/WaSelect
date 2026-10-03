-- 017：`payments.dispute_status` 补域约束（第三轮审查 TST3-05）。
--
-- @why 它是拒付状态机列：`has_dispute` 是否复位由它的取值决定（lost 保持限制，won / withdrawn 解除）。
--      但它在 001 里只是 `VARCHAR(16)`，库层不设防——将来某次改写把机构原始状态（如 `warning_closed`）
--      原样写进来，库照收；风控列表按 withdrawn 筛不到它，这条拒付的锁也再没人能解。
--      结构不变量（db.db.test.ts「任何 status 列都有域约束」）原来只认列名恰好是 `status` 的列，所以漏了它；
--      现在按 `(^|_)status$` 匹配，这一列没有约束就红。
-- @why 取值集合与 `server/src/domain/dispute-input.ts` 的 `DISPUTE_STATUS`、契约 `Dispute.dispute_status` 枚举一致；
--      NULL 合法（没有拒付的支付行）。
--
-- @see server/src/app/mark-disputed.ts；server/src/adapters/db.db.test.ts；docs/自主决策记录.md AJ-246
--
-- @breaking ⚠️ up 段 `ADD CONSTRAINT … CHECK`：收紧（同 002 / 009 那两条）。
--      窗口里仍在服务的旧代码若写入四值之外的值 → 23514 → 50000。
--      **这一版之所以安全，只因为部署时生产还没有任何流量**（未上线、表是空的），
--      且写入方 `mark-disputed.ts` 的取值集合与本约束同源（`DISPUTE_STATUS`）。
--      ⚠️ 另有一处**将来**才会痛的代价：PG 的 `ADD CONSTRAINT … CHECK` 会**立即全表校验**
--      并持有 ACCESS EXCLUSIVE 锁直到校验完成。现在 `payments` 是空的，成本为 0；
--      等表大了再加约束，标准做法是 `NOT VALID` 先加、再单独 `VALIDATE`（后者只拿弱锁）。
--      @see test/lint/migrations.lint.test.ts（本标记的强制器，DB2-07 / AJ-317）
--
-- Up migration

ALTER TABLE payments
  ADD CONSTRAINT payments_dispute_status_domain
  CHECK (dispute_status IS NULL OR dispute_status IN ('open', 'won', 'lost', 'withdrawn'));

-- Down migration

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_dispute_status_domain;
