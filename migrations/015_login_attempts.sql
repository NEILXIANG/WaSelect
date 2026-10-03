-- 015：登录失败计数与锁定**从 users 行搬到独立表 `login_attempts`**（A1 + B14；AJ-187）。
--
-- @why 014 把计数与锁加在 users 的两列上，有两个绕不过去的缺陷，都是"设计时就错、不是实现错"：
--      ① **取锁时机**：路由先 `findAdminCredential` 读一次锁，再花 ~100ms 跑 bcrypt，
--         最后才 `recordLoginFailure` 计数（admin-auth-routes.ts 旧实现）。并发突发时
--         N 个请求都读到"未锁"，于是**全部**走完 bcrypt——账号维度"最多试 5 次"
--         并没有被真正封顶。文件头 AJ-181 声称的"口令爆破在账号维度被封顶"不成立。
--         修法是把"扣一次尝试额度"提到 bcrypt **之前**、并放在一条带
--         "未锁定"条件的原子 UPDATE 里：0 行命中即已锁，直接 42901 且不碰 bcrypt。
--      ② **不存在的邮箱既不计数也不上锁**：users 里没有这个邮箱就没有行，计数无处可落。
--         于是"同一邮箱连错 6 次，第 6 次是 429 还是 401"能区分这个邮箱**是不是已注册账号**
--         ——登录口变成管理员邮箱探测器（B14）。而"知道管理员邮箱"正是①的攻击前提。
-- @why 键是 `sha256(lower(email))` 的 hex 而不是邮箱本身：这张表会为**根本不存在的邮箱**建行，
--      存明文等于把"谁被探测过"落成一张表（约束七脱敏红线：禁邮箱明文）。
--      @limitation 确定性哈希（无盐）挡不住"拿到库后枚举候选邮箱比对哈希"，
--      但它保护的是更现实也更严重的那一种——**库被拖走后不直接泄露邮箱清单**。
--      要用口令学 KDF 加盐就查不到键了（每次都得全表算），不可行；这是明确的取舍。
-- @why 独立表而不是继续加列：不存在的邮箱在 users 里没有行，列无处可落。
--      反过来，users 的两列必须**删掉**而不是留着：两个落点会让"到底锁没锁"变成两处答案（F2 单一事实源）。
-- @limitation 这张表会为每一个被试探的邮箱留一行。行数上界靠两道：
--      ① IP 限流（`RATE_LIMIT_LOGIN_PER_15MIN`，D-52）约束"一个出口能造多少行"；
--      ② daily 作业清掉 `last_failed_at` 早于 24h 且未锁定的行（app/login-attempts-cleanup.ts）。
--      没有②时它是"只增不删"的表——被换 IP 慢慢试探时最终会撑到磁盘告警，且没人会去看它。
--
-- @see server/src/adapters/admin-auth.ts；server/src/app/admin-auth-routes.ts；
--      server/src/app/login-attempts-cleanup.ts；docs/自主决策记录.md AJ-187
--
-- @breaking ⚠️ up 段 `ALTER TABLE users DROP COLUMN …`：删的是**旧版本代码仍在读的列**。
--      Render 的部署顺序是 `preDeployCommand` 先跑迁移、旧实例在新实例健康前继续接流量，
--      所以从迁移完成到新实例接管之间存在窗口，窗口里 014 口径的代码
--      `select login_locked_until / failed_login_count` → **42703 → 50000**（管理员登录 500）。
--      附带后果：正在生效的锁随列一起消失 ⇒ **部署即解锁**（有人正在爆破时尤甚）。
--      **这一版之所以安全，只因为部署时生产还没有任何流量**（未上线、库是空的）。
--      ⚠️ 这个理由**不会一直成立**：今后对 `orders` / `payments` / `users` 做同样的事，
--      必须按 **expand → contract 两步走**——第一版只"停用"（代码不再读、写入新落点），
--      确认全量切到新代码之后的**下一个版本**才删。
--      @see test/lint/migrations.lint.test.ts（本标记的强制器，DB2-07 / AJ-317）
--
-- Up migration

CREATE TABLE IF NOT EXISTS login_attempts (
  key_hash TEXT PRIMARY KEY
    CONSTRAINT login_attempts_key_hash_shape CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  failed_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT login_attempts_failed_count_nonneg CHECK (failed_count >= 0),
  locked_until TIMESTAMPTZ,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 014 加在 users 上的两列随即退休：锁定的唯一真源变成 login_attempts。
ALTER TABLE users
  DROP COLUMN IF EXISTS login_locked_until,
  DROP COLUMN IF EXISTS failed_login_count;

-- Down migration

DROP TABLE IF EXISTS login_attempts;

-- 回滚要把 014 的两列原样补回（列名/类型/约束与 014 逐字一致），
-- 否则 down 到 014 时 admin-auth.ts 的两列实现会读到不存在的列。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT users_failed_login_count_nonneg CHECK (failed_login_count >= 0),
  ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMPTZ;
