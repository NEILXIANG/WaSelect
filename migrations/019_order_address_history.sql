-- 019：改址的**改前地址**迁出 `order_events`，落到一张**可匿名化**的历史表（AJ-293；DB3-03 / APPI）。
--
-- @why `updateAddressSnapshot` 为了 B12 / AJ-208 的取证链（"盗号 → 联系客服改址 → 货发给攻击者 →
--      真买家以未收到货拒付"），把**改前完整旧地址**以 `JSON.stringify({ from: previous })` 写进
--      `order_events.note`。而 `order_events` 挂 `trg_order_events_append_only`（002 迁移），
--      UPDATE/DELETE 一律 42501 ⇒ 这条 PII **永久锁死**，任何删除 / 匿名化请求都兑现不了（AJ-292）。
-- @why **B12 要的是"改前地址可查"，并没有要求它锁在 append-only 里**——这是本迁移能成立的全部理由：
--      迁到一张不带触发器的表之后，取证链一步不变（按 id 查回完整旧地址），
--      但这部分 PII 从此可以被匿名化或删除，AJ-292 的匿名化出口才真正通。
-- @why 本表**刻意不挂** append-only 触发器：可改正是它的目的。
--      代价是"发生过一次改址"这个**事实**的审计强度低一档——
--      缓解办法是 `order_events` 里仍然留一条（时间、操作者、归档号都在，且**那条**是 append-only）：
--      可改的只是地址**内容**，"发生过改址"这件事仍不可抹。
-- @why 顺带修掉一个**既有的**暴露面：`admin-web/src/orders/OrderDetail.tsx` 把 `e.note` 原样渲染在
--      订单时间线上 ⇒ 现状下**所有能看到订单详情的运营都能看到改前完整地址明文**。
--      迁出之后 note 只留一句人话 + 归档号，PII 从"人人可见"收回"需要时按号查"。
--
-- @limitation 一：**只加表、不改旧行**。存量 `order_events.note` 里的全文保持原样
--              （表能改、历史行改不了），本迁移**不**假装能清理它们。
--              读取侧要同时看得懂两种形态：旧行读 note 里的 `from`，新行按 `from_id` 查本表。
-- @limitation 二：down 会 DROP 本表 ⇒ **生产回滚有损**（归档的旧地址查不回来）。
--              已在此显式写明"不可回滚"；但为了过 `migrations.db.test.ts` 的 up→down→up 门禁，
--              down 必须把 schema 清干净——"schema 可回滚"与"数据回滚有损"是两件事，
--              不能因为后者就省掉前者（漏 DROP 会让二次 up 因对象已存在而失败）。
-- @limitation 三：运营**自助**查看改前地址的入口本迁移不提供（现状其实也谈不上好用——是一坨 JSON）。
--              取证是低频事件，按归档号查库完全可行；若将来运营反馈需要自助，
--              加一个带权限的接口是**纯增量**（本表已就位）。
--
-- @see server/src/adapters/orders-admin.ts（updateAddressSnapshot）；
--      docs/自主决策记录.md AJ-208 / AJ-272 / AJ-292 / AJ-293

-- Up migration

CREATE TABLE order_address_history (
  id         BIGSERIAL PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  -- 改前的完整地址快照。**刻意不带 append-only 触发器**：可匿名化正是它的存在理由（AJ-292）。
  snapshot   JSONB NOT NULL,
  actor      TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_address_history_order_at ON order_address_history (order_id, at);

COMMENT ON TABLE order_address_history IS
  '改址的**改前**地址归档（AJ-293）。刻意不挂 append-only：可匿名化 / 可删除是它的存在理由。'
  '`order_events` 里对应事件的 note 只留归档号 —— "发生过改址"这个事实仍在 append-only 表里，'
  '可改的只是地址内容。';
COMMENT ON COLUMN order_address_history.snapshot IS
  '改前完整地址快照（recipient / phone / line1 / city / state / postal_code）。'
  '用于"盗号改址 → 拒付"的取证（B12 / AJ-208）；不下发给前端，按需查库。';

-- Down migration
-- ⚠️ 生产**不可回滚**：DROP 之后已归档的改前地址查不回来（B12 取证链的存量会丢）。
--    这里保留 DROP 只为满足 up→down→up 的 schema 一致性门禁，不代表它可以在生产上执行。

DROP TABLE IF EXISTS order_address_history;
