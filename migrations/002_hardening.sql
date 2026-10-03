-- 002：地基加固（P1）——外键索引、状态域约束、审计表 append-only、ADR-29 缺失的两张日志表。
--
-- @why 这一批都不是"功能"，而是**防止未来某天静默出错**的约束。它们的共同点是：
--      缺了不会让任何测试变红，只会在数据量上来、或出事故要查审计时才暴露，届时已无法补救。
--
-- @limitation 一：**没有**给 `payments.status` / `shipments.status` 加 CHECK。
--              原因是 api-contract.yaml 里这两者**没有枚举定义**（只有订单状态与商品状态有）。
--              在这种地方"顺手编一套取值"是最危险的写法：契约一旦补上枚举，
--              数据库会开始拒绝合法数据，而这个约束在单人开发阶段不会有人注意到。
--              宁可暂时不约束，等 0.6 契约补枚举后再加——这条待办写在本文档末尾。
--              ⚠️ **这条待办后来的走向**（DB-14，2026-10-03 回写，别再照着下面那两行找）：
--                · `payments.status` —— **009 已补**（`payments_status_domain`）。
--                  不是等 api-contract 补枚举，而是三审指出技术文档 §3 早已枚举五个取值、
--                  且 001 的部分唯一索引 `uq_payments_one_initiated` 本来就依赖 `'initiated'` 字面量
--                  ⇒ "契约未枚举"这个理由**当时就不成立**（见 009 @why 三）。
--                · `shipments.status` —— **至今仍未补，且是有意的**：
--                  技术文档 §3 只给了 `DEFAULT created`、没有枚举取值集合
--                  （轨迹状态要随承运商 P1 接入再定）。它在 `db.db.test.ts` 的 STATUS_EXEMPT 里
--                  **带书面理由豁免**——该机制要求豁免必须写原因，所以这不是"忘了"，是"还没定"。
--                  将来承运商接入、口径定下来之后，照 009 的纪律走新迁移补，不要回改本文件。
-- @limitation 二：新增 `user_events` / `admin_audit` 两张表后，实际表数由 13 变为 15，
--              与技术文档 v0.5 §3 的"13 张表"不一致。**技术文档需要同步补这两张表**。
--              加它们不是可选优化：ADR-29（已定的日志规范）要求三条日志流，
--              其中流 C 的用户行为落 `user_events`、流 B 的管理员操作落 `admin_audit`——
--              缺表意味着这两条流**根本无法实现**，属于硬阻塞，不是"以后再说"。
--              `outbox_events` 不在此列：清单 v1.2 附录 #15 已裁定 outbox 降级，不建表。
--
-- @see docs/代码注释规范与日志体系设计.md（三条流）、docs/地基搭建清单.md F7、ADR-29
--
-- @breaking ⚠️ up 段给 `orders.status` 等列 `ADD CONSTRAINT … CHECK`：这是在**收紧**
--      ——窗口里仍在服务的旧版本代码若写入枚举外的值（哪怕是拼写错），会被库拒（23514 → 50000）。
--      **这一版之所以安全，只因为部署时生产还没有任何流量**（未上线、表是空的），
--      且旧代码写入的取值本来就在枚举内。
--      ⚠️ 这个理由**不会一直成立**：上线后要收紧任何约束，必须先确认
--      "当前所有写入方产出的值都合法"（必要时先 `NOT VALID` 加约束、观察一段时间再 `VALIDATE`），
--      否则就是"部署期间一阵 500"。
--      @see test/lint/migrations.lint.test.ts（本标记的强制器，DB2-07 / AJ-317）
--
-- Up migration

-- ── 1. 外键索引 ────────────────────────────────────────────────────────────
-- @why Postgres **不会**自动给外键列建索引。缺它的两个后果：
--      ① 父表删/改一行时，Postgres 必须对子表做**全表扫描**确认没有子行引用——
--         订单删除、商品下架这类操作会随着数据量线性变慢，而且只在生产数据量下才显现；
--      ② 按外键查（"这张单的所有明细"）永远走顺序扫描。
--      已有索引的不再重复建：orders(user_id,created_at)、order_events(order_id,at) 在 001 已建。
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses (user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments (order_id);

-- ── 2. 状态域约束 ──────────────────────────────────────────────────────────
-- @why `status VARCHAR(20)` 什么都能装。一旦某个 bug 写入 'payed'（拼写错），
--      这行订单就会从所有状态查询里消失——不报错、不报警，只是"用户看不到自己的订单了"。
--      取值与 packages/shared/src/enums.ts 的 ORDER_STATUS 逐字一致（10 态）。
ALTER TABLE orders
  ADD CONSTRAINT orders_status_domain CHECK (
    status IN ('created','pending_payment','paid','shipped','delivered',
               'completed','cancelled','expired','refunding','refunded')
  );

-- 契约已枚举：active / offline（见 api-contract.yaml /admin/products/{id}/status）
ALTER TABLE products
  ADD CONSTRAINT products_status_domain CHECK (status IN ('active','offline'));

-- ── 3. 审计表：ADR-29 流 B / 流 C 的落点 ───────────────────────────────────
-- @why 运行日志（流 A）可以采样、可以丢、可以到第三方；审计流与用户行为流**不能**。
--      它们必须落在我们自己的库里、与业务数据同库同事务，否则"什么时候改的价格、谁改的"
--      这类问题永远答不上来——而跨境业务里这正是争议与合规检查要问的第一句。
CREATE TABLE user_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT,
  session_id TEXT,
  event      VARCHAR(64) NOT NULL,
  -- 事件参数。**只存结构化字段，不存自由文本**：props 是查询面，塞进去的东西都要能被检索
  props      JSONB NOT NULL DEFAULT '{}',
  trace_id   TEXT,
  req_id     TEXT,
  path       VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_events_user_created ON user_events (user_id, created_at DESC);
CREATE INDEX idx_user_events_event_created ON user_events (event, created_at DESC);

CREATE TABLE admin_audit (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     VARCHAR(64) NOT NULL,
  target     VARCHAR(128),
  before     JSONB,
  after      JSONB,
  trace_id   TEXT,
  req_id     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_audit_actor_created ON admin_audit (actor, created_at DESC);
CREATE INDEX idx_admin_audit_target ON admin_audit (target, created_at DESC);

-- ── 4. append-only：审计记录不可改 ──────────────────────────────────────────
-- @why 用**触发器**而不是"在应用里自觉不写 UPDATE"：自觉会失效，
--      而且最需要改审计记录的时刻（有人想掩盖一次误操作）正是自觉最不可靠的时刻。
--      也有人用"REVOKE UPDATE + 单独的应用角色"，那更彻底但要改连接角色与迁移账号，
--      当前单人开发阶段先用触发器（对所有连接生效，含超级用户），F7b 再评估角色方案。
-- @limitation 触发器挡不住 `TRUNCATE`（DDL 不走行级触发器）。
--      测试库重置依赖 TRUNCATE，这是有意的；生产严禁对审计表 TRUNCATE，靠权限与流程约束。
CREATE OR REPLACE FUNCTION deny_audit_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '审计表 % 只允许 INSERT：UPDATE/DELETE 被拒绝（append-only，见 ADR-29）', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION deny_audit_modification();

CREATE TRIGGER trg_user_events_append_only
  BEFORE UPDATE OR DELETE ON user_events
  FOR EACH ROW EXECUTE FUNCTION deny_audit_modification();

CREATE TRIGGER trg_admin_audit_append_only
  BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION deny_audit_modification();

-- 待办（不在本迁移内，需先改契约）：payments.status / shipments.status 的 CHECK，
-- 等 api-contract 0.6 补上这两个枚举后以 003 号迁移追加。
--
-- ⚠️ 上面两行**已经过期，只作历史保留**（DB-14）：
--    · "以 003 号迁移追加"是错的——003 最终是幂等与身份（003_idempotency_and_identity）。
--      003 自己又把这条顺延到 005，而 005 最终是回调处理租约。**待办被顺延了两次就断了**，
--      这正是"待办写在注释里"的失败模式：它不会红，只会慢慢指错地方。
--    · 真正的结局见本文件头 @limitation 一 的回写：payments.status 由 **009** 补上，
--      shipments.status 至今在 db.db.test.ts 的 STATUS_EXEMPT 里带理由豁免。
--    · 教训：迁移注释里的"待办"必须写**由谁、按什么信号触发**，不能只写"以后再加"；
--      否则下一步改迁移的人（包括我）只会照着它继续顺延。

-- Down migration

DROP TRIGGER IF EXISTS trg_admin_audit_append_only ON admin_audit;
DROP TRIGGER IF EXISTS trg_user_events_append_only ON user_events;
DROP TRIGGER IF EXISTS trg_order_events_append_only ON order_events;
DROP FUNCTION IF EXISTS deny_audit_modification();

DROP TABLE IF EXISTS admin_audit;
DROP TABLE IF EXISTS user_events;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_domain;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_domain;

DROP INDEX IF EXISTS idx_shipments_order;
DROP INDEX IF EXISTS idx_payments_order;
DROP INDEX IF EXISTS idx_order_items_product;
DROP INDEX IF EXISTS idx_order_items_order;
DROP INDEX IF EXISTS idx_addresses_user;
