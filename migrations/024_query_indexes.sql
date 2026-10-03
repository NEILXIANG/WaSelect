-- 024：给两条**已经存在、但没有索引支撑**的查询补索引（DB-13 / CAT-19）。
--
-- @why 现在补，而不是"等慢了再说"——这是本次唯一真正的理由，其余都是次要的：
--      `CREATE INDEX` 会拿一张会阻塞写入的锁，**在表还是空的（或未上线）时成本为 0**；
--      等上线之后再补，标准做法是 `CREATE INDEX CONCURRENTLY`——
--      它不能在事务里跑、失败会留下 INVALID 索引要手工清理，
--      而且要单独安排一次窗口。017 / 023 记过同一条代价（CHECK 的全表校验同理）。
--      换言之一句话：**索引这件事的窗口就是"上线前"，错过它成本翻好几倍。**
--
-- ── ① `login_attempts.last_failed_at`（清理作业） ─────────────────────────
-- @why `deleteStaleLoginAttempts` 每天跑一次：
--      `where last_failed_at < cutoff and (locked_until is null or locked_until < cutoff)`。
--      没有索引 ⇒ 每次都是**整表扫描**。
-- @why 这张表**恰恰是全库唯一被设计成会无限增长的那一张**：
--      015 的 @limitation 明写"被换 IP 慢慢试探时最终会撑到磁盘告警"，
--      行数上界只靠 IP 限流与这个清理作业两道。也就是说清理作业扫描的表
--      **只会越来越大**，而它自己就是唯一能让它变小的东西——
--      "扫描成本随表增长，而表靠这次扫描收缩"是一个会自我恶化的组合。
-- @why 不用部分索引：清理条件里 `locked_until` 出现在 `or` 的两支，
--      任何 `where locked_until is null` 的部分索引都会**漏删**"已解锁但还没清掉的行"
--      （那些行 `locked_until` 是一个过去时刻，不是 null）。这里必须全表覆盖。
--
-- ── ② `products (status, created_at desc, id)`（商品列表） ───────────────
-- @why `catalog.ts` 的公开列表是：
--      `where status = 'active' [and category = ?] [and title ilike '%kw%'] order by created_at desc, id limit/offset`，
--      后面还**紧跟一条同样条件的 `count(*)`**。没有任何索引 ⇒ 每次请求一次全表扫描 + 一次排序，
--      而这个接口是**每个访客每次进店都会打**的（不是管理端低频操作）。
-- @why 列顺序取 `(status, created_at desc, id)` 而不是把 `category` 放第二位：
--      ① 无关键词时，索引直接给出"已上架 + 按时间倒序"的顺序，limit/offset 可以走有序扫描，
--         不必先扫全表再排序；② 带 `category` 时 PG 仍能用第一列定位到 active 段再过滤；
--      ③ `category` 只有四个取值、区分度极低，放在第二列会让索引变大而收益很小。
-- @limitation ⚠️ `and title ilike '%kw%'`（**前置通配符**）**任何** B-tree 索引都帮不上——
--              关键词搜索是全表扫描，这一条不会因为加了本索引而改变。
--              真要做商品搜索得上 `pg_trgm` 或全文检索，那是另一个决定，不在本次。
-- @limitation ⚠️ 当前商品数是十位数级，PG 很可能**仍然选择 seq scan**（小表扫描比走索引更便宜）。
--              这一点不掩饰：本索引在**今天**几乎肯定用不上，它的价值在"表长到几百行之后"
--              与"避免了将来在活表上建索引"。不能拿它宣称"解决了列表慢"——今天列表不慢。
--
-- ── 明确**不做**的一条（CAT-19 原文建议过，本次不采纳） ──────────────────
-- @limitation `payments (dispute_opened_at desc) where dispute_id is not null` 不建：
--      `adapters/risk-admin.ts` 的 `listDisputes` 里已有一条**书面的 @tradeoff**——
--      "拒付在 MVP 是个位数级，全表扫描的代价远小于'两条 SQL 各维护一份判据'"。
--      那条 tradeoff 的前提是"筛判据必须只有一份"（`dispute_id is not null`），
--      而不是"加索引不好"。在有人重开这个话题之前，按原作者的取舍执行；
--      真到拒付量起来那天，应当先重读那条 @tradeoff 再决定，而不是直接把索引加上。
--
-- @see server/src/adapters/admin-auth.ts（deleteStaleLoginAttempts）；
--      server/src/adapters/catalog.ts（公开商品列表 + count）；
--      server/src/adapters/risk-admin.ts（listDisputes 的 @tradeoff）；
--      migrations/015_login_attempts.sql（"这张表会无限增长"的那段 @limitation）；
--      server/src/adapters/db.db.test.ts（索引清单断言）
--
-- Up migration

CREATE INDEX IF NOT EXISTS idx_login_attempts_last_failed ON login_attempts (last_failed_at);

CREATE INDEX IF NOT EXISTS idx_products_status_created ON products (status, created_at DESC, id);

-- Down migration

DROP INDEX IF EXISTS idx_login_attempts_last_failed;
DROP INDEX IF EXISTS idx_products_status_created;
