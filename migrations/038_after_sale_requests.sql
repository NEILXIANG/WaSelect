-- 038：买家售后申请（AJ-420，小程序电商对比分析"售后入口最小闭环"）。
--
-- @why 此前买家收到货有问题只能去微信找人：没有记录、换人接手要翻聊天记录、买家看不到进度。
--      034 的内部备注是"运营自己记"，这张表是"买家提出、运营处理、买家看到结果"——两件事，不合表。
-- @why 原因 / 状态都在库里加域约束（结构不变量：status 列必须有 *_status_domain）；取值与
--      packages/shared/src/after-sale.ts 同口径，改枚举两处一起改（db.db.test 只查约束存在，不查取值）。
-- @why "同一订单同时只能有一条进行中"**只靠部分唯一索引**守，应用层不先查：直接插，撞 23505 → 40902
--      （adapters/after-sales.ts 只认这一个约束名）。先查后插挡不住买家连点两次——两个请求都会"先查没有"。
-- @why 不存联系方式 / 地址：要联系买家从订单现取；description 是买家原话，可能含电话，按约束七不进日志（只进本表）。
-- @limitation 一：处理历史只保留**最后一次**（status / resolution_note / handled_by 被覆盖）；
--             中间每一步谁改的、改成什么，靠 admin_audit（审计中间件自动写，含请求体）追溯。
-- @limitation 二：不带图片（MVP）。
-- @limitation 三：description 的 CHECK 按码位 ≤ 500，应用层按字符（[...s]）≤ 500，二者一致；CHECK 是兜底。
--
-- @see server/src/adapters/after-sales.ts；server/src/app/after-sale-routes.ts；docs/自主决策记录.md AJ-420

-- Up migration

CREATE TABLE after_sale_requests (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  reason          VARCHAR(20) NOT NULL CONSTRAINT after_sale_requests_reason_domain
                    CHECK (reason IN ('not_received', 'damaged', 'wrong_item', 'quality', 'other')),
  description     TEXT NOT NULL CONSTRAINT after_sale_requests_description_check
                    CHECK (char_length(description) BETWEEN 1 AND 500),
  status          VARCHAR(16) NOT NULL DEFAULT 'open' CONSTRAINT after_sale_requests_status_domain
                    CHECK (status IN ('open', 'processing', 'resolved', 'rejected')),
  resolution_note TEXT CONSTRAINT after_sale_requests_note_check
                    CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 500),
  handled_by      TEXT CONSTRAINT after_sale_requests_handled_by_check
                    CHECK (handled_by IS NULL OR handled_by ~ '^admin:[^[:space:]]+$'),
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

-- 外键索引（结构不变量）兼作"按单取、按时间排"
CREATE INDEX idx_after_sale_requests_order ON after_sale_requests (order_id, created_at);
CREATE INDEX idx_after_sale_requests_user ON after_sale_requests (user_id);
-- 同一订单同时只能有一条进行中的申请（@why 第三条）
CREATE UNIQUE INDEX uq_after_sale_requests_open ON after_sale_requests (order_id)
  WHERE status IN ('open', 'processing');

-- Down migration

DROP INDEX IF EXISTS uq_after_sale_requests_open;
DROP INDEX IF EXISTS idx_after_sale_requests_user;
DROP INDEX IF EXISTS idx_after_sale_requests_order;
DROP TABLE IF EXISTS after_sale_requests;
