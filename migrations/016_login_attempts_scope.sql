-- 016：登录额度按「邮箱 × 来源」分桶后，给每一行记上它属于哪个邮箱（AJ-243，第二轮审查 SEC2-01）。
--
-- @why 015 的额度只按邮箱计、连错 5 次锁 15 分钟，而 IP 限流恰好也是 5 次 / 15 分钟——
--      知道管理员邮箱的人用**一个** IP 就能让管理员一直登不上。现在额度改成两层：
--      ① `sha256(lower(email) + 来源)` 的**来源桶**（5 次）——一个来源只能锁住它自己；
--      ② `sha256(lower(email))` 的**邮箱桶**（30 次）——总尝试数仍然有顶。
--      来源桶的键里混了来源，单凭邮箱算不出来；而管理员改密（`npm run admin:password`）
--      必须能一次清掉这个邮箱名下的全部桶（否则管理员自己打错 5 次后，改完密码仍被自己那个来源锁着）。
--      所以每一行多记一列 `scope_hash` ＝ 邮箱桶的键：来源桶填它，邮箱桶自己留空。
-- @why 仍然只存哈希、不存邮箱明文（与 015 同一条理由：这张表会为不存在的邮箱建行）。
-- @why 加索引：清理按 `scope_hash = $1` 删；没有索引就是全表扫（行数上界见 015 @limitation）。
--
-- @see server/src/adapters/admin-auth.ts（loginAttemptSourceKey / deleteLoginAttemptsForEmail）；
--      server/src/app/admin-auth-routes.ts；scripts/admin-password-lib.ts；docs/自主决策记录.md AJ-243

-- Up migration

ALTER TABLE login_attempts
  ADD COLUMN IF NOT EXISTS scope_hash TEXT
    CONSTRAINT login_attempts_scope_hash_shape CHECK (scope_hash IS NULL OR scope_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS login_attempts_scope_hash_idx ON login_attempts (scope_hash);

-- Down migration

DROP INDEX IF EXISTS login_attempts_scope_hash_idx;

ALTER TABLE login_attempts
  DROP COLUMN IF EXISTS scope_hash;
