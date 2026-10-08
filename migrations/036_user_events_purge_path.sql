-- 036：`user_events` 的**受控删除窄口**（AJ-413）——180 天保留期清理 + APPI「按 user_id 删除」的唯一路径。
--
-- @why 002 给 `user_events` 挂了 append-only 触发器（UPDATE / DELETE 一律 42501），而隐私政策承诺
--      "使用记录保存 180 天后删除、用户要求即删除"。AJ-138 原想用 SECURITY DEFINER 函数绕过，
--      复核（2026-10-06）发现它只换执行角色、**不跳过** BEFORE 触发器——所以这里改触发器本身：
--      给它留一道**只对 DELETE 有效、只在事务内有效**的口子：`SET LOCAL waselect.user_events_purge = 'on'`。
--      @measured（2026-10-09，PG 16.15）：未设时 DELETE → 42501；事务内 SET LOCAL 后 DELETE 放行、UPDATE 仍 42501；
--      COMMIT 后 `current_setting(…, true)` 回 NULL（口子随事务关闭）；事务外 SET LOCAL 只给 WARNING、不生效。
-- @why 用 GUC 而不是"专用角色 + WHEN (current_user <> …)"：托管 PG 上建角色需要 CREATEROLE，迁移账号未必有；
--      GUC 不需要任何权限，且 `SET LOCAL` 把作用域钉死在一个事务里——忘了关也不会泄漏到下一条语句。
--      代价：任何拿到连接的人都能开这道口子。接受的理由：能拿到连接的人本来就能 TRUNCATE（002 @limitation），
--      口子没有扩大攻击面，只是把"删"从"不可能"变成"必须显式声明 + 必须在事务里"。
-- @why 不动 `deny_audit_modification()`：它同时守 order_events / admin_audit / reconciliation_runs / order_notes，
--      那几张表**没有**保留期承诺，口子不该开到它们身上；user_events 单独一个函数、单独一条触发器。
-- @why 补 `idx_user_events_created`：保留期清理按 `created_at < cutoff` 扫，原有两个索引（user_id, created_at）/
--      （event, created_at）都带前导列，服务不了这条条件；没有它，表一大每天的清理就是一次顺序扫描。
-- @limitation 口子只认字面量 'on'：`SET LOCAL … = 'ON'` / 'true' 都不放行（current_setting 返回原串，不做大小写归一）。
--      这是刻意的——口子越窄越好，应用层只有 adapters/user-events.ts 一处会设它。
--
-- @see server/src/adapters/user-events.ts（唯一设置 GUC 的地方）；server/src/app/user-events-retention.ts（daily 作业）；
--      docs/自主决策记录.md AJ-413 / AJ-138 复核

-- Up migration

-- 报错文案保留 002 的前缀「只允许 INSERT」：现有断言（db.db.test / user-events.db.test）按它匹配
CREATE OR REPLACE FUNCTION deny_user_events_modification() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('waselect.user_events_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    '审计表 % 只允许 INSERT：UPDATE/DELETE 被拒绝（append-only，见 ADR-29；行为流的受控清理须在事务内 SET LOCAL waselect.user_events_purge = ''on''，AJ-413）', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_events_append_only ON user_events;
CREATE TRIGGER trg_user_events_append_only
  BEFORE UPDATE OR DELETE ON user_events
  FOR EACH ROW EXECUTE FUNCTION deny_user_events_modification();

CREATE INDEX IF NOT EXISTS idx_user_events_created ON user_events (created_at);

-- Down migration

DROP INDEX IF EXISTS idx_user_events_created;

DROP TRIGGER IF EXISTS trg_user_events_append_only ON user_events;
CREATE TRIGGER trg_user_events_append_only
  BEFORE UPDATE OR DELETE ON user_events
  FOR EACH ROW EXECUTE FUNCTION deny_audit_modification();

DROP FUNCTION IF EXISTS deny_user_events_modification();
