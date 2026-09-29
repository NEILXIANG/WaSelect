-- 014：管理员登录的**账号维度**失败锁定（D-38 ⑤：连续失败 5 次锁 15 分钟；O-11 / AJ-181）。
--
-- @why 限流（RATE_LIMIT_LOGIN_PER_15MIN，按 IP）挡不住"换 IP 慢慢试同一个账号"——
--      那正是对管理员口令最现实的攻击形态（住宅代理池）。锁定必须记在**账号**上，
--      而账号的唯一落点就是 users 行：两列足够表达"已经连错几次 / 锁到什么时候"。
-- @why 计数与锁放在库里、由一条 UPDATE 原子地读改写（adapters/admin-auth.ts recordLoginFailure）：
--      进程内计数在多实例 / 重启后会丢，且两次并发失败会各读到同一个旧值（第 6 次还能试）。
-- @why failed_login_count 加 CHECK (>= 0)：它只会被 +1 或清零，出现负数只能是写坏了——
--      与 db.db.test.ts「状态/计数列要有域约束」同一口径。
-- @limitation 只对 users 表生效（管理员与小程序用户同表，小程序用户没有口令，永远不会走到这两列）。
--
-- @see server/src/adapters/admin-auth.ts；server/src/app/admin-auth-routes.ts；docs/自主决策记录.md AJ-181
-- Up migration

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT users_failed_login_count_nonneg CHECK (failed_login_count >= 0),
  ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMPTZ;

-- Down migration

ALTER TABLE users
  DROP COLUMN IF EXISTS login_locked_until,
  DROP COLUMN IF EXISTS failed_login_count;
