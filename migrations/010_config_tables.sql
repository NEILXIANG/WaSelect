-- 010：duty_rates + payment_channels + app_config（ADR-28 四张新增配置表的余下三张；全库 17 → 20 张）。
--
-- @why 这三张表是"业务核心不认识任何具体支付方式/国家/UI"（ADR-28 硬性要求）的数据锚：
--      ① `duty_rates(origin,dest,rate)` —— 关税率外置（取代配置项 `DUTY_RATE_US`，config.ts @limitation 三
--         早已声明"当前零消费方，表落地后接线"）。I1 报价域（U4）是它的第一个消费方。
--      ② `payment_channels` —— 通道开关/排序/市场覆盖的**运营配置**（D-56：上下线通道不发版）。
--         ⚠️ I1 只落地表与种子，**消费方不接线**：装配仍走 env（`PAYMENT_CHANNELS` + CHANNEL_DEFAULTS），
--         与 F11 country_profiles 的口径一致——"没有真实消费方的接线是假可插拔"。
--      ③ `app_config` —— 运行期 KV（条款版本、运营开关等"改它不改代码"的东西）。
--         ⚠️ 刻意**不落任何 seed**：没有消费方的 key 是死数据（007 @why 同口径），
--         第一个 key 必须连同它的消费方一起落地。
--
-- @why seed 口径（与 007 相同）：只落**今天就是事实**的数据，不塞占位——
--      duty_rates 落 ('JP','US',0.15)（MVP 只卖日产、只发美国，D-42/D-43）；
--      payment_channels 落 mock/stripe/wechat 三行，字段值**逐字等于** channels.ts 的 CHANNEL_DEFAULTS
--      （由 payment-channels-seed.db.test.ts 的字段级同源比对钉死），行为零变化。
--
-- @limitation 一：duty_rates 的 0.15 是**占位口径**（13b 未定：15% / 13.04% / 17.25% 三口径待 D 决策）。
--      I1 报价里 duty_jpy 只是**信息字段、不计入 total**，改口径 = 改这一行数据，不改代码。
-- @limitation 二：rate 用 NUMERIC(6,5) 而不是 FLOAT8——浮点的 0.15 不是 0.15
--      （二进制近似），金额相关的比率绝不能用浮点存（与 price_jpy 用 BIGINT 同一个判断）。
-- @limitation 三：三张表都是**配置表不是业务表**——resetTestDb / seed 清表脚本把它们放排除名单
--      （与 country_profiles 同列）；被清后不会自动补回 seed，补救只能 down 再 up（test-db.ts @limitation）。
--
-- @see docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md §3（ADR-28）；docs/I1阶段开发实施方案.md §3.7；
--      migrations/007_country_profiles.sql（配置表的建表/seed 口径模板）

-- Up migration

-- ① 关税率（原产地 × 目的国）：I1 报价域的第一个真实消费方（duty_jpy 信息字段）。
CREATE TABLE duty_rates (
  origin_country CHAR(2) NOT NULL,
  dest_country   CHAR(2) NOT NULL,
  rate           NUMERIC(6,5) NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (origin_country, dest_country),
  CONSTRAINT duty_rates_origin_upper CHECK (origin_country ~ '^[A-Z]{2}$'),
  CONSTRAINT duty_rates_dest_upper CHECK (dest_country ~ '^[A-Z]{2}$'),
  -- 关税率是"比率"：[0,1)。负率不存在；≥1 表示"税比货贵"，只可能是录错
  CONSTRAINT duty_rates_rate_range CHECK (rate >= 0 AND rate < 1)
);

-- 13b 未定（三口径待 D 决策）：0.15 是占位，note 里把未定状态写死，防止有人把占位当结论
INSERT INTO duty_rates (origin_country, dest_country, rate, note)
VALUES ('JP', 'US', 0.15, '13b 未定：15%/13.04%/17.25% 三口径待 D 决策；duty_jpy 仅信息字段不计入 total（D-42 占位口径）');

-- ② 支付通道运营配置（消费方暂不接线，见文件头 @why ②；字段值与 CHANNEL_DEFAULTS 同源）
CREATE TABLE payment_channels (
  channel    TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL,
  priority   INT NOT NULL,
  countries  JSONB NOT NULL CHECK (jsonb_typeof(countries) = 'array'),
  currencies JSONB NOT NULL CHECK (jsonb_typeof(currencies) = 'array'),
  label      TEXT NOT NULL,
  icon       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 通道 key 形状：与注册表 key 同一约定（小写标识符；D-56 的"任意字符串"指不枚举，不是没形状）
  CONSTRAINT payment_channels_key_shape CHECK (channel ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT payment_channels_label_nonempty CHECK (length(label) > 0)
);

-- 值逐字等于 server/src/adapters/payment/channels.ts 的 CHANNEL_DEFAULTS（同源比对测试钉死）。
-- enabled 口径：wechat 未实现（R1 事前相談前）不开放新单；mock/stripe 对应现行 PAYMENT_CHANNELS 基线。
INSERT INTO payment_channels (channel, enabled, priority, countries, currencies, label, icon) VALUES
  ('wechat', FALSE, 10, '["*"]', '["JPY"]', '微信支付', 'wechat'),
  ('stripe', TRUE,  20, '["*"]', '["USD"]', '银行卡',  'card'),
  ('mock',   TRUE,  90, '["*"]', '["JPY"]', '模拟支付', 'flask');

-- ③ 运行期 KV（刻意零 seed：第一个 key 连同消费方一起落地，见文件头 @why ③）
CREATE TABLE app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_config_key_shape CHECK (key ~ '^[a-z][a-z0-9_.]{0,63}$')
);

-- Down migration

DROP TABLE IF EXISTS app_config;
DROP TABLE IF EXISTS payment_channels;
DROP TABLE IF EXISTS duty_rates;
