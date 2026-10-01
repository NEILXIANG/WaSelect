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

-- Up migration

ALTER TABLE payments
  ADD CONSTRAINT payments_dispute_status_domain
  CHECK (dispute_status IS NULL OR dispute_status IN ('open', 'won', 'lost', 'withdrawn'));

-- Down migration

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_dispute_status_domain;
