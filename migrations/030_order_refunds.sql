-- 030：order_refunds——部分退款与订单完成后的售后退款（AJ-383，工程缺口第二轮 §6.3 G3 / G4）。
--
-- @why 订单状态机只有"整单 refunding → refunded"一条退款路径（技术文档 §1），代购最常见的
--      "多件缺一件 / 一件破损"退不了；订单 completed 之后更是没有任何退款出口（只能去 Stripe 后台手退，账实不符）。
--      部分退款**不改订单状态**（主线仍是 paid → shipped → delivered → completed），每笔退款一行，记在这张表。
-- @why 金额按**支付币种的最小单位**记（与 payments.charge_amount 同口径）：扣的就是这个币种，按它退是精确的；
--      按 JPY 填再折算会多一次取整，几分钱的差在对账里就是一条解释不清的差额。
-- @why 状态五值：initiated（已登记、尚未拿到机构答复）/ pending（机构受理、未落定）/ succeeded / failed（机构确认失败）/
--      unknown（调机构时超时或连接中断，结果不明——**同一把幂等键重试**取回结果，不能当失败换键，否则可能退两次）。
--      "不超退"的求和口径：除 failed 外都占额度（initiated / pending / unknown 都可能已经退出去了）。
-- @why provider_ref 部分唯一：同一张机构退款单不能被记成两笔（重放 / 并发同步时的最后一道防线）。
-- @limitation 不是 append-only：状态要从 initiated 走到终态。谁在什么时候发起、结果如何，另由 order_events
--      （partial_refund 系列事件）与 admin_audit 留痕；本表只是"当前账"。
--
-- @see server/src/adapters/order-refunds.ts；server/src/app/partial-refund*.ts；docs/自主决策记录.md AJ-383

-- Up migration

CREATE TABLE IF NOT EXISTS order_refunds (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  payment_id    TEXT NOT NULL REFERENCES payments(id),
  currency      CHAR(3) NOT NULL,
  amount_minor  BIGINT NOT NULL CONSTRAINT order_refunds_amount_positive CHECK (amount_minor > 0),
  reason        TEXT NOT NULL,
  status        VARCHAR(16) NOT NULL CONSTRAINT order_refunds_status_domain
                  CHECK (status IN ('initiated', 'pending', 'succeeded', 'failed', 'unknown')),
  provider_ref  VARCHAR(128),
  actor         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_order_refunds_order ON order_refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_order_refunds_payment ON order_refunds (payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_refunds_provider_ref
  ON order_refunds (provider_ref) WHERE provider_ref IS NOT NULL;

-- Down migration

DROP TABLE IF EXISTS order_refunds;
