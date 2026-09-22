-- 初始 schema：忠实照抄《技术文档 v0.5》§3 的 13 张表（含 D-43 job_runs、D-51 banners）。
--
-- @why 迁移是"数据库结构的唯一事实来源"：技术文档里的 DDL 是设计，落地以本文件为准，
--      两边若有差异，以本文件为运行时真值，但必须立刻回头改文档——否则下一个读文档的人会照着错的写。
-- @limitation 一：本迁移**不含** ADR-28 要求的 4 张扩展表（country_profiles / duty_rates /
--              payment_channels / app_config）。它们属于"表 13→17"的口径变更，需先改技术文档 v0.6
--              与 api-contract 0.6.0 并确认后，再以 002 号迁移追加——不允许地基阶段擅自扩表。
-- @limitation 二：原文档 order_items 末列后有尾逗号（SQL 语法错误），此处已修正，
--              文档同步修（见 jp 技术文档 §3）。
-- @limitation 三：append-only（order_events 不可 UPDATE/DELETE）尚未实施，见 002 号迁移与 F7b。
--
-- @see 技术文档 v0.5 §3；docs/地基搭建清单.md F7

-- Up migration

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  openid        VARCHAR(64) UNIQUE,
  email         VARCHAR(255) UNIQUE,
  password_hash TEXT,
  phone         VARCHAR(32),
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (openid IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE addresses (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  recipient     VARCHAR(100) NOT NULL CHECK (recipient ~ '^[ -~]+$'),
  phone         VARCHAR(20)  NOT NULL CHECK (phone ~ '^\+1[0-9]{10}$'),
  line1         VARCHAR(200) NOT NULL CHECK (line1 ~ '^[ -~]+$'),
  line2         VARCHAR(200) CHECK (line2 IS NULL OR line2 ~ '^[ -~]*$'),
  city          VARCHAR(100) NOT NULL CHECK (city ~ '^[ -~]+$'),
  state         CHAR(2) NOT NULL,
  postal_code   VARCHAR(10) NOT NULL CHECK (postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  country       CHAR(2) NOT NULL DEFAULT 'US',
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fx_rates (
  id             SERIAL PRIMARY KEY,
  quote          CHAR(3) NOT NULL,
  rate           NUMERIC(18,8) NOT NULL,
  raw_rate       NUMERIC(18,8) NOT NULL,
  buffer         NUMERIC(6,4) NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  created_by     TEXT,
  UNIQUE (quote, effective_from)
);

CREATE TABLE products (
  id              TEXT PRIMARY KEY,
  title           VARCHAR(255) NOT NULL,
  category        VARCHAR(32) NOT NULL,
  description     TEXT,
  images          JSONB NOT NULL DEFAULT '[]',
  price_jpy       BIGINT NOT NULL CHECK (price_jpy > 0),
  cost_jpy        BIGINT,
  weight_g        INT NOT NULL CHECK (weight_g > 0),
  stock           INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  compliance_tags JSONB NOT NULL DEFAULT '[]',
  hs_code         VARCHAR(10),
  customs_desc_en VARCHAR(120),
  origin_country  CHAR(2) NOT NULL,
  CONSTRAINT products_origin_jp CHECK (origin_country = 'JP'),
  title_ja        VARCHAR(255),
  jan_code        VARCHAR(13),
  purchase_source VARCHAR(255),
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shipping_rates (
  id           SERIAL PRIMARY KEY,
  carrier      VARCHAR(32) NOT NULL,
  max_weight_g INT NOT NULL,
  price_jpy    BIGINT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (carrier, max_weight_g)
);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  order_no        VARCHAR(20) NOT NULL UNIQUE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'created',
  items_jpy       BIGINT NOT NULL,
  shipping_jpy    BIGINT NOT NULL DEFAULT 0,
  duty_jpy        BIGINT NOT NULL DEFAULT 0,
  total_jpy       BIGINT NOT NULL,
  weight_g        INT NOT NULL DEFAULT 0,
  fx_snapshot     JSONB NOT NULL,
  charge_currency CHAR(3),
  charge_amount   BIGINT,
  is_test         BOOLEAN NOT NULL DEFAULT FALSE,
  address_snapshot JSONB NOT NULL,
  contact_email   VARCHAR(255),
  terms_version   VARCHAR(16) NOT NULL,
  carrier         VARCHAR(32),
  tracking_no     VARCHAR(64),
  pay_token_hash  TEXT,
  has_dispute     BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at      TIMESTAMPTZ NOT NULL,
  paid_at         TIMESTAMPTZ,
  shipped_at      TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  refunded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_user_created ON orders (user_id, created_at DESC);
CREATE INDEX idx_orders_open_status ON orders (status) WHERE status IN ('created','pending_payment','paid');

CREATE TABLE order_items (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders(id),
  product_id         TEXT NOT NULL REFERENCES products(id),
  title_snapshot     VARCHAR(255) NOT NULL,
  qty                INT NOT NULL CHECK (qty > 0),
  unit_price_jpy     BIGINT NOT NULL,
  weight_g           INT NOT NULL DEFAULT 0,
  declared_value_usd BIGINT NOT NULL
);

CREATE TABLE order_events (
  id       BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  status   VARCHAR(20) NOT NULL,
  note     TEXT,
  actor    TEXT,
  at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_events_order_at ON order_events (order_id, at);

CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders(id),
  provider          VARCHAR(16) NOT NULL,
  provider_ref      VARCHAR(128),
  transaction_id    VARCHAR(128),
  status            VARCHAR(16) NOT NULL,
  charge_currency   CHAR(3) NOT NULL,
  charge_amount     BIGINT NOT NULL,
  paid_amount       BIGINT,
  paid_currency     CHAR(3),
  settled_jpy       BIGINT,
  fee_jpy           BIGINT,
  provider_fx       NUMERIC(18,8),
  reconciled_at     TIMESTAMPTZ,
  raw_callback      JSONB,
  pay_url           TEXT,
  dispute_id        VARCHAR(128),
  dispute_status    VARCHAR(16),
  dispute_amount    BIGINT,
  dispute_closed_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, transaction_id),
  UNIQUE (provider, provider_ref)
);
CREATE UNIQUE INDEX uq_payments_one_initiated ON payments (order_id) WHERE status = 'initiated';

CREATE TABLE shipments (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  carrier     VARCHAR(32) NOT NULL,
  tracking_no VARCHAR(64) NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'created',
  events      JSONB NOT NULL DEFAULT '[]',
  shipped_at  TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

CREATE TABLE idempotency_keys (
  key        TEXT PRIMARY KEY,
  user_id    TEXT,
  route      TEXT NOT NULL,
  status_code INT NOT NULL,
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE banners (
  id        TEXT PRIMARY KEY,
  image_key TEXT NOT NULL,
  link_type VARCHAR(16) NOT NULL DEFAULT 'none',
  link_id   TEXT,
  sort      INT NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMPTZ,
  ends_at   TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_runs (
  name            TEXT PRIMARY KEY,
  last_success_at TIMESTAMPTZ,
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 首次迁移就 seed：否则后续 UPDATE 静默无效（0 行），看门狗永远读不到心跳（D-45）
INSERT INTO job_runs (name) VALUES ('tick'), ('daily') ON CONFLICT (name) DO NOTHING;

-- Down migration

DROP TABLE IF EXISTS job_runs;
DROP TABLE IF EXISTS banners;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS order_events;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS shipping_rates;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS fx_rates;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS users;
