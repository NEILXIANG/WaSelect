-- 005：回调处理租约（二审 N22 / 甄别报告 P2）。
--
-- @why 修前的三态把两种完全不同的情况合并成了同一个 `retry`：
--        ① **正在处理中**（另一个请求正拿着这个事件在跑）；
--        ② **崩溃遗留**（上次处理到一半进程死了，processed_at 停在 NULL）。
--      两者在库里的样子完全一样（`processed_at IS NULL`），于是并发重复投递时
--      两个请求**都会**去处理同一个事件：业务写入有订单状态兜底不会错，
--      但事件行本身的 `result` 会被后写完的覆盖——"这条回调到底怎么处理的"就说不清了，
--      而这张表存在的唯一理由就是**举证**（@see 003 的 @why）。
--
-- @why 解法与幂等的租约同源（N1）：给"处理中"一个**租约 + 栅栏令牌**，
--      `processing_until` 未过期的行 = 有人正持有，别人不许碰；过期了才允许接管。
--      这样 `retry` 只剩"崩溃遗留"一种语义，并发那边得到一个新的 `inflight` 态。
--
-- @why 允许 NULL 而不回填（与 004 同理）：历史行没有存活持有者，回填没有意义；
--      写入路径（005 之后的代码）永远带令牌。
--
-- @why NULL 租约必须被判成"**可接管**"（`processing_until is null or processing_until < now()`），
--      否则 005 之前的旧行会永久卡死：它们既没有租约、也没人能碰，
--      既进不了 `retry` 也进不了 `handled`，只能等人工改数据。
--      @limitation 代价是 NULL 与"租约已过期"在当前逻辑下不可区分（两者都判 retry）；
--                 将来若要区分，需再加一列，并连 `releaseWebhookLease` 一起改（AJ-41）。
--
-- @limitation 租约是**时长**不是心跳：持有者若真卡死，要等满租约才允许接管，
--      期间机构收到的都是 503（会重发，不会丢）。想更早接管就要引入续期，
--      代价是多一条后台写——回调处理是本地 DB 操作，量级上不需要。
--
-- @see server/src/webhooks.ts（claimWebhookEvent 的四态）；docs/地基搭建清单.md 欠账登记 N22

-- Up migration

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processing_until TIMESTAMPTZ;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processing_token UUID;

-- 待处理（没处理完）的扫描索引：对账任务（F13）按它找"该补处理"的行
CREATE INDEX IF NOT EXISTS idx_webhook_events_unfinished
  ON webhook_events (provider, processed_at)
  WHERE processed_at IS NULL;

-- Down migration

DROP INDEX IF EXISTS idx_webhook_events_unfinished;
ALTER TABLE webhook_events DROP COLUMN IF EXISTS processing_token;
ALTER TABLE webhook_events DROP COLUMN IF EXISTS processing_until;
