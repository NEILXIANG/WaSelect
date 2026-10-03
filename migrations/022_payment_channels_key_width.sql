-- 022：`payment_channels.channel` 的形状从 **≤32 字符**收紧到 **≤16**（DB-16 / CAT-15）。
--
-- @why 010 建表时给的 CHECK 是 `^[a-z][a-z0-9_]{0,31}$`（首字符 + 31 ⇒ 共 32），
--      而 `payments.provider` 与 `webhook_events.provider` 都是 **VARCHAR(16)**（001:144），
--      通道注册表同样按 16 拦（B32 / DB-05 的 `.max(32)` 是另一处、且已修）。
--      于是这张配置表允许存进一个 **17–32 字符**的通道 key：
--      它在 `payment_channels` 里**合法**（约束放行），但只要这张表接了线、
--      拿它去写 `payments.provider`，PG 立刻报 **22001**（value too long）。
--      这类"配置能存、用起来才炸"的不一致是最难归因的一类——
--      错误发生在**另一张表、另一个模块、另一个时刻**（下单 / 回调时），
--      而那条配置是运营很久以前填的，没人会把两件事连起来。
-- @why **用新迁移收紧，而不是回去改 010**。
--      改**已应用**的迁移是静默无效的：`pgmigrations` 账本里 010 已是 applied，
--      生产库不会重跑它 ⇒ **新装的库是 32、生产库是 16**，两边行为不同且看不出来。
--      "顺手订正旧迁移"看起来是清理，实际是埋一个环境分歧；
--      而分歧只在"某个环境用得上 17–32 字符 key"那天才暴露，那时已经无从追溯是谁改的。
--
-- @breaking ⚠️ up 段 `DROP CONSTRAINT` + `ADD CONSTRAINT`：收紧约束属破坏性变更
--      （窗口里旧代码写入的新值可能不再合法 → 23514）。
--      **这一版安全，只因为 `payment_channels` 至今没有任何写入方**：
--      010 的文件头写明"消费方暂不接线"，全仓没有代码往这张表 insert / update，
--      表里只有 010 自己 seed 的三行（`mock` / `wechat` / `stripe`，都远短于 16）。
--      所以窗口里不存在"旧代码往里写值"这回事——收紧拦不到任何真实写入。
--      ⚠️ 这个理由**不会一直成立**：将来给这张表接上管理端编辑口之后，
--      任何进一步的收紧都必须**先查后改**（`select` 确认现有值全部合法），
--      否则会把运营已经配好的通道一次性变成读不出来 / 写不进去。
--
-- @limitation 只收紧**长度**，不动字符集（`[a-z][a-z0-9_]`）。
--      字符集与注册表 key 的约定同源（D-56），改它会牵动 `channels.ts`，不属本次。
-- @limitation 不做"已有行校验后再决定要不要加"：若真有不合法行，
--      `ADD CONSTRAINT` 会**直接失败**、迁移停在那里——那正是想要的结果。
--      宁可迁移失败、库停在旧状态（还能用），也不要静默放过一条存不进 payments 的配置；
--      后者会在几周后的下单路径上以 22001 的形式冒出来，而那时没人会想到是通道名太长。
--
-- @see migrations/010_config_tables.sql:61（原约束）；migrations/001_init.sql:144（payments.provider VARCHAR(16)）；
--      server/src/adapters/payment/channels.ts（CHANNEL_DEFAULTS / 注册表上限）；
--      test/lint/migrations.lint.test.ts（本标记的强制器，DB2-07 / AJ-317）
--
-- Up migration

ALTER TABLE payment_channels DROP CONSTRAINT IF EXISTS payment_channels_key_shape;
ALTER TABLE payment_channels
  ADD CONSTRAINT payment_channels_key_shape CHECK (channel ~ '^[a-z][a-z0-9_]{0,15}$');

-- Down migration

ALTER TABLE payment_channels DROP CONSTRAINT IF EXISTS payment_channels_key_shape;
ALTER TABLE payment_channels
  ADD CONSTRAINT payment_channels_key_shape CHECK (channel ~ '^[a-z][a-z0-9_]{0,31}$');
