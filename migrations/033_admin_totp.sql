-- 033：管理员 TOTP 第二因素（第三轮缺口 P1-5，AJ-386）。
--
-- @why 管理端是单因素（邮箱 + 口令）却握有直接退款权；且登录锁定可被远程持续触发（≥6 个来源轮流错口令
--      就能把邮箱桶打满），管理员自救只有命令行改密。开了 TOTP 的账号：口令 + 6 位码才发 token，
--      且**邮箱桶锁着时**带着正确码仍可登录（攻击者没有码，锁不死真管理员）。
-- @why totp_last_step：同一个码在 ±30 秒窗口内都有效，记下"最后用过的步数"、只接受更大的步，
--      偷看到（肩窥 / 录屏）的码不能再用第二次（RFC 6238 §5.2）。
-- @limitation totp_secret 明文存（HMAC 要用原值，哈希存不了）：拖库者拿到密钥即可算码——但他同时还需要口令
--             （口令只存 bcrypt）。要再加一层需引入应用层加密密钥，MVP 不做（AJ-386 反向风险）。
-- @limitation 开通 / 关闭只走命令行（npm run admin:totp），管理端界面不提供——不让"拿到 token 的人"自己关掉第二因素。
--
-- @see server/src/adapters/totp.ts；server/src/app/admin-auth-routes.ts；scripts/admin-totp.ts

-- Up migration

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;

-- Down migration

ALTER TABLE users DROP COLUMN IF EXISTS totp_last_step;
ALTER TABLE users DROP COLUMN IF EXISTS totp_secret;
