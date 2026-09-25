-- 007：country_profiles（目的国档案）+ US 种子（F11 单元④，字段定义来自 ADR-28 §3.2）。
--
-- @why 这张表是"多国家可扩展"的**数据锚**（ADR-28 是硬性要求）。今天代码里散着三处美国口径：
--      ① `addresses` 表的 CHECK 约束（phone `^\+1[0-9]{10}$`、postal_code `^[0-9]{5}(-[0-9]{4})?$`、
--         state CHAR(2)）② 配置默认值 `DISPLAY_CURRENCIES=CNY,USD` ③ 关税常量 `DUTY_RATE_US`。
--      三处的共同毛病是"加第二个国家要改代码"，而 ADR-28 要的是"加国家只加一行数据"。
--      本迁移只做**第一步**：把国家档案落进表，值**逐字等于**上面①的现行约束
--      （由 country-profiles.db.test.ts 的"字段级同源比对"钉死），所以行为零变化。
--
-- @why seed 只落 **US 一条**：MVP 只发美国（D-43；ADR-28 §6"MVP 行为不变"）。
--      不预先塞 CA / JP 占位——没有真实消费方的种子数据是"看起来已支持多国家"的假象，
--      它会在第一个真实国家进来时变成一份要被改正的错误数据（比没有数据更糟：有人会信它）。
--
-- @tradeoff JSONB 整体存 vs 拆 `country_address_fields` 子表：模板是嵌套结构
--      （fields[] 每项自带 pattern / maxLength / options），拆子表更像关系模型，
--      换来的是"读一次国家档案要 JOIN"、"整体替换模板变成多行事务"。
--      国家档案是**运营配置**不是业务数据：读取极频繁、写入极少、几乎不做行级查询
--      → JSONB 整体存更贴使用方式。代价是模板内部结构不受数据库约束
--      （DB 只能 CHECK 到 `jsonb_typeof` 与顶层键），结构校验落在应用层的 zod schema。
--
-- @limitation 一：`phone_pattern` / `postal_pattern` 的**正则合法性数据库管不了**——
--      PG 没有"这串字符能不能编译成正则"的 CHECK；非法正则只在真去匹配时才抛错，
--      而那时已经在一个用户请求里了。所以应用层解析时强制 `new RegExp()` 试编译，
--      编译不过响亮失败（见 adapters/country-profiles.ts 的 compilePattern）。
-- @limitation 二：`allowed_carriers` / `blocked_tags` seed 为**空数组**，这不表示"美国无限制"，
--      而是这两条规则当前**没有任何消费方**（运费表尚无真实承运商数据、合规标签尚无枚举口径）。
--      第一个真实值必须连同消费方一起落地，否则就是死数据。
-- @limitation 三：本表只描述**目的国**。原产国侧 `products.origin_country='JP'` 的约束仍在
--      products 表；`duty_rates(origin, dest, rate)`（ADR-28 列 P1）尚未建表，本迁移不涉及。
--
-- @see docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md §3.2（字段定义来源 / ADR-28）；
--      server/src/adapters/country-profiles.ts（仓储 + 结构校验 + 正则试编译）；
--      migrations/001_init.sql（addresses 的 CHECK 与列宽，是本 seed 唯一的取值来源）

-- Up migration

CREATE TABLE country_profiles (
  code               CHAR(2) PRIMARY KEY,
  active             BOOLEAN NOT NULL DEFAULT TRUE,

  display_currencies JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(display_currencies) = 'array'),
  address_template   JSONB NOT NULL CHECK (jsonb_typeof(address_template) = 'object'),
  phone_pattern      TEXT NOT NULL CHECK (length(phone_pattern) > 0),
  postal_pattern     TEXT NOT NULL CHECK (length(postal_pattern) > 0),
  allowed_carriers   JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(allowed_carriers) = 'array'),
  blocked_tags       JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(blocked_tags) = 'array'),
  duty_note          TEXT NOT NULL DEFAULT '',

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT country_profiles_code_upper CHECK (code ~ '^[A-Z]{2}$'),
  CONSTRAINT country_profiles_template_fields CHECK (
    jsonb_typeof(address_template -> 'fields') = 'array'
    AND jsonb_array_length(address_template -> 'fields') > 0
  )
);

-- US 种子：值逐字等于 migrations/001 里 addresses 表的现行约束，行为零变化。
-- ⚠️ JSON 字符串内的反斜杠必须写成 `\\`：SQL 层（standard_conforming_strings=on）不再吃一层，
--    留给 JSON 解析吃一层，最终落到正则里是 `\+`。写成单个 `\` 会让 JSON 解析直接失败。
INSERT INTO country_profiles (code, active, display_currencies, address_template, phone_pattern, postal_pattern, duty_note)
VALUES (
  'US',
  TRUE,
  '["CNY","USD"]',
  '{"fields":[
     {"key":"recipient","label":"收件人","required":true,"maxLength":100,"pattern":"^[ -~]+$"},
     {"key":"phone","label":"电话","required":true,"maxLength":20,"pattern":"^\\+1[0-9]{10}$"},
     {"key":"line1","label":"地址行 1","required":true,"maxLength":200,"pattern":"^[ -~]+$"},
     {"key":"line2","label":"地址行 2","required":false,"maxLength":200,"pattern":"^[ -~]*$"},
     {"key":"city","label":"城市","required":true,"maxLength":100,"pattern":"^[ -~]+$"},
     {"key":"state","label":"州","required":true,"maxLength":2},
     {"key":"postal_code","label":"邮编","required":true,"maxLength":10,"pattern":"^[0-9]{5}(-[0-9]{4})?$"}
   ]}',
  '^\+1[0-9]{10}$',
  '^[0-9]{5}(-[0-9]{4})?$',
  '价格已含关税与运费（DDP），收货时无需另付'
);

-- Down migration

DROP TABLE IF EXISTS country_profiles;
