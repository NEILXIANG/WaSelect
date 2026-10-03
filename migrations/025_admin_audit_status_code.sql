-- 025：给 `admin_audit` 加一列**最终 HTTP 状态码**（SEC2-02 / AJ-339）。
--
-- @why 审计中间件原来只写 2xx，理由是"反过来的错误（审计了但没改）不会发生（只写 2xx）"。
--      这条理由在**两段式写操作**上不成立：管理端退款是
--        第一段（事务内）把订单迁到 `refunding` 并**提交**；
--        第二段（事务外）调机构，超时 / 结果未知时抛 `provider_error` → 5xx。
--      于是最需要留痕的那一次退款——"钱可能已经退了、我们不知道"——
--      `admin_audit` 里**没有**这一行（`order_events` 有 refunding 事件与 actor，
--      所以不是完全无痕；但"谁在什么时候发起了退款、它最后成了没有"查不到）。
--      而管理员若不再重试，这一行永远不会补上——审计是 append-only，事后补不回来。
--
-- @why **必须**把状态记下来，不能只是"改成 5xx 也写"：
--      那样就把文件头承诺的等价关系（"有审计行 ⇔ 改动真的发生了"）换成了
--      "有审计行 ⇔ 有人点了一次"，于是"审计了但没做成"这个**更坏**的方向被打开了——
--      事后按审计回溯时会把一次失败的退款读成成功的。
--      记 `status_code` 之后，两种情形在同一张表里可区分，且都不丢。
--      ⚠️ 注意"改动"的定义也随之精确化：两段式里**第一段提交**就是已发生的改动
--      （订单状态真的变了），第二段失败改不了这个事实。
--
-- @why 单独一列而不是塞进 `after`（JSONB）里：
--      `after` 的语义是"管理员要把它改成什么"（= 请求体），
--      往里混一个 `_status` 会让它不再是请求体，且检索要下钻 JSONB。
--      状态码是一个独立的、会被用来筛的事实，它该有自己的列。
--
-- @why 可空、无默认值、不加 CHECK：
--      ① 可空 ⇒ 加列本身不触碰任何既有行（加带 DEFAULT 的非空列在 PG 11 之前要重写整表，
--          而这张表将来会有很多行）；
--      ② 可空同时表达"老数据没有这一列时写不进来"这件事——历史行老老实实是 NULL，
--          不是被猜成一个 200；
--      ③ 不加 CHECK：状态码的取值域由应用侧保证（`res.statusCode` 天然是 100–599），
--          在库里再写一份区间只会多一处要同步的事实（约束九）。
--      ⚠️ 本迁移**不挂**破坏性标记：up 段只加一个可空列，不 DROP、不收紧、不 SET NOT NULL、
--          也不 TRUNCATE，因此不属于 `test/lint/migrations.lint.test.ts` 要管的那一类。
--          （= 顺带一条纪律：注释里**不要**把那个标记当词写出来——守卫是按"文件头有没有这个
--          字符串"判的，写"本迁移不需要 X"会被当成真的挂了 X 而变红。要说就换个说法。）
--
-- @limitation 只有"路由显式声明已提交"（`markAuditCommitted`）的非 2xx 才会落这一列；
--            4xx / 5xx 且未提交的写请求仍然不写审计（没有发生的改动不该出现在审计里）——
--            这是既有的正确行为，本次不动。
--
-- @see server/src/app/admin-audit.ts（markAuditCommitted 与中间件判定）；
--      server/src/app/admin-order-routes.ts（退款：第一段提交后调用它）；
--      server/src/ports/admin-audit.ts（AdminAuditEntry.statusCode）；
--      migrations/002_hardening.sql（admin_audit 建表与 append-only 触发器）

-- Up migration

ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS status_code SMALLINT;

COMMENT ON COLUMN admin_audit.status_code IS
  '最终 HTTP 状态码（SEC2-02 / AJ-339）。NULL = 该行写入时还没有这一列，或当时的中间件不记状态；'
  '非 2xx 的行只可能是"路由显式声明改动已提交、但后续步骤失败"（如两段式退款的机构调用）。';

-- Down migration

ALTER TABLE admin_audit DROP COLUMN IF EXISTS status_code;
