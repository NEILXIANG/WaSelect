-- 009：US 国家档案关税文案对齐 D-32 + 删除 webhook_events 的重复部分索引（第三轮审计）。
--
-- @why 一：007 的 seed 写着 `价格已含关税与运费（DDP），收货时无需另付`——与 D-32 直接相反：
--      口径是「商品价含美国关税（DDP）；**国际运费按包裹重量分档、结算时单列**」（PRD 与
--      `.env.example` 的表述都是对的，只有这条 seed 写反）。`country-profiles.ts` 把它定义为
--      "前端展示的关税口径文案"，接入详情页后就是向用户承诺含运费、结算页再收运费——
--      投诉与拒付抗辩的直接证据。用 UPDATE 而不是回改 007：迁移一旦应用就是历史，改历史只会让
--      "已跑过 007 的库"与"新库"分叉。
-- @why 二：003 建了 `idx_webhook_events_pending`，005 又建了定义**逐字相同**的
--      `idx_webhook_events_unfinished`（`(provider, processed_at) WHERE processed_at IS NULL`）。
--      每次 claim / finish / release 都多维护一份索引，且第二列在 `IS NULL` 谓词下恒为 NULL、
--      没有区分度。保留 005 的那份（AJ-46 引用的名字），删 003 的那份。
--      db.db.test.ts 新增通用不变量：同表不得有定义相同的两个索引。
--
-- @why 三：`payments.status` 此前在 db.db.test.ts 的域约束豁免名单里，理由是"契约未枚举"——
--      但技术文档 v0.5 §3 明确枚举 `initiated / succeeded / failed / cancelled / refunded`，
--      且 001 的部分唯一索引 `uq_payments_one_initiated` 已经依赖 `'initiated'` 字面量。
--      理由不成立，按文档口径补 CHECK；将来要加状态（例如 I1 的 `expired`）走新迁移，
--      与 orders_status_domain 同一纪律。命名沿用 002 的 `<table>_status_domain`。
--
-- @limitation down 只恢复索引与删约束；文案不回滚成错的（错误文案没有"恢复"的价值）。
--
-- @see 决策日志 D-32；migrations/007_country_profiles.sql；migrations/003 / 005；
--      docs/自主决策记录.md AJ-90

-- Up migration

UPDATE country_profiles
   SET duty_note = '价格已含美国关税（DDP，收货时无需另付关税）；国际运费按包裹重量分档，结算时单列',
       updated_at = now()
 WHERE code = 'US';

DROP INDEX IF EXISTS idx_webhook_events_pending;

ALTER TABLE payments
  ADD CONSTRAINT payments_status_domain
  CHECK (status IN ('initiated', 'succeeded', 'failed', 'cancelled', 'refunded'));

-- Down migration

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_domain;

CREATE INDEX IF NOT EXISTS idx_webhook_events_pending ON webhook_events (provider, processed_at)
  WHERE processed_at IS NULL;
