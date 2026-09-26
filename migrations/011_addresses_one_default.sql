-- 011：每用户最多一条默认地址（部分唯一索引）。
--
-- @why 方案 §3.5 写"默认地址唯一（DB 已有约束）"——**开工核查发现并没有**（001 只有列定义，
--      没有任何唯一索引）。应用层"先把其它地址清默认再设新默认"在并发下有两个请求同时
--      通过检查、同时落两条默认的窗口；部分唯一索引让数据库来做这件事
--      （与 003 用 UNIQUE(provider,event_id) 做幂等去重是同一个判断：DB 约束比应用层先查再插可靠）。
--
-- @why 用部分索引（WHERE is_default）而不是 (user_id, is_default) 复合唯一：
--      后者允许"一条默认 + 任意多条非默认"吗？不——(user_id, is_default) 唯一意味着
--      一个用户最多一条 is_default=true **和最多一条** is_default=false，完全错误。
--      部分唯一索引是 PG 表达"每用户最多一条默认"的唯一正确形态。
--
-- @limitation 历史脏数据：若上线前已有用户存在多条默认，本迁移会失败——这是刻意的
--      （响亮失败 > 静默建不了索引）；MVP 阶段库内地址全部来自 seed/测试，无此情况。
--
-- @see migrations/001_init.sql（addresses 表）；docs/I1阶段开发实施方案.md §3.5；
--      server/src/adapters/addresses.ts（应用层的"先清后设"与索引互为纵深）

-- Up migration

CREATE UNIQUE INDEX addresses_one_default_per_user
  ON addresses (user_id) WHERE is_default;

-- Down migration

DROP INDEX IF EXISTS addresses_one_default_per_user;
