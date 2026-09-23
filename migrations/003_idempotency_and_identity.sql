-- 003：幂等可恢复性 + 身份吊销 + 回调留痕（评审 P0-3/P0-4、D19、D25）。
--
-- @why 这三件事的共同点是：**现在改零成本，上线后改要处理真实数据**。
--      幂等表还没有真实订单、users 表里只有 seed 的管理员、回调还没接真实机构——
--      一旦开始收单，改表结构就要写数据迁移和灰度方案，而这三件事都属于"不改迟早出事"：
--        · 幂等占位行没有租约 → 进程崩一次，该键永久卡死（用户再也下不了这一单）
--        · 幂等不记请求指纹 → 客户端复用键的 bug 被静默吞掉（用户以为下了第二单）
--        · token 无法吊销 → 改密/封禁后旧 token 在有效期内仍然可用
--        · 回调不留痕 → 机构说"我发了回调"，我们无法证明收到过什么（争议举证时是硬伤）
--
-- @limitation 一：`webhook_events` 只做"收到即登记 + 幂等处理"的底座，
--              真正的**对账**（按 provider 拉单比对、补齐漏处理事件）在每日任务里做（F13），不在此处。
-- @limitation 二：002 号里"payments.status / shipments.status 的 CHECK 以 003 追加"的待办
--              顺延到 **004**：那一条依赖 api-contract 0.6 补枚举，与本次无关联，
--              不为凑编号把两件不相干的事塞进同一个迁移。
--
-- @see docs/基座评审复核意见-2026-09-23.md（D3/D4/D19/D25）；docs/地基搭建清单.md F8

-- Up migration

-- ── 1. users.token_ver：token 版本，用于改密 / 封禁后即时失效（D25）────────────
-- @why JWT 是无状态的，签发之后服务端拿不回来。没有版本号就意味着"改密后旧 token 依然能进后台"，
--      而管理员 token 有效期是 12 小时——泄露后的处置窗口被拉到 12 小时，这是不可接受的。
--      `ver` 已经在 payload 里躺着（auth.ts 的 Principal.ver），缺的只是"拿它跟库里比对"这一步。
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_ver INTEGER NOT NULL DEFAULT 1;

-- ── 2. 邮箱大小写不敏感唯一（D19）────────────────────────────────────────────
-- @why `email VARCHAR(255) UNIQUE` 只保证**精确**唯一：`Bob@Example.com` 与 `bob@example.com`
--      可以同时存在，于是同一个管理员有两个账号；登录时大小写不一致还找不到人。
--      用函数索引 `lower(email)` 而不是把列本身改成小写：保留用户输入的原始形态（展示与邮件发送要用），
--      唯一性另建索引——两者不该混为一件事。
-- @limitation 只覆盖 ASCII 大小写。邮箱本地部分的大小写语义按 RFC 5321 是"由域自行解释"，
--              主流服务商都忽略大小写，故此举已足够；真遇到区分大小写的域，登录时会因找不到用户而失败（可发现）。
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- ── 3. idempotency_keys：租约 + 指纹 + 完成时间（D3 / D4）────────────────────
-- @why 原表只有 (key, status_code, response)：
--        · 抢到占位后进程崩溃 → 那行永远停在 status_code=0 → 同键**永久** 40903（D3）
--        · 不记请求内容 → 同一个键换了请求体，直接返回首次结果（D4）
--      这两条的错误方向相反（一个永久拒绝、一个错误地接受），但根源都是"记录的信息不够"。
ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS request_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- @why 清理任务要按"创建时间"扫过期行：没有索引时是全表扫描，
--      而这张表是**写入最密集**的表之一（每次下单都写），没有索引的清理会拖慢下单。
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys (created_at);

-- ── 4. webhook_events：回调留痕与去重（D3）───────────────────────────────────
-- @why 机构（Stripe / 微信）对同一个事件会**多次**投递，且重试窗口长达数天。
--      没有事件表时，"这条回调我们处理过没有"只能靠订单状态间接推断；
--      而"机构说发了、我们说没收到"这类争议，举证材料就是这张表。
--      用 `UNIQUE (provider, event_id)` 让数据库来做去重——比应用层"先查再插"可靠（后者有竞态）。
-- @limitation `payload` 存原始报文会碰 APPI/PCI 红线（规范禁止记回调原文），
--              因此只存 `payload_hash`：足以证明"两次收到的是同一份内容"，又不落个人信息。
CREATE TABLE IF NOT EXISTS webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  provider      VARCHAR(16) NOT NULL,
  event_id      VARCHAR(128) NOT NULL,
  event_type    VARCHAR(64),
  payload_hash  VARCHAR(64),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  -- 32 而不是 16：`ignored:order_not_found` 这类"处理过但被忽略"的取值就有 22 字符，
  -- 写不下会变成运行时 22001 错误——而它只在特定冲突分支才触发，测试不覆盖就发现不了。
  result        VARCHAR(32),
  note          TEXT,
  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_pending ON webhook_events (provider, processed_at)
  WHERE processed_at IS NULL;

-- Down migration

DROP INDEX IF EXISTS idx_webhook_events_pending;
DROP TABLE IF EXISTS webhook_events;

DROP INDEX IF EXISTS idx_idempotency_keys_created;
ALTER TABLE idempotency_keys
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS locked_until,
  DROP COLUMN IF EXISTS request_hash;

DROP INDEX IF EXISTS users_email_lower_key;
ALTER TABLE users DROP COLUMN IF EXISTS token_ver;
