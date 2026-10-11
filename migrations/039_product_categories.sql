-- 039：商品分类改为后台可配置（用户 2026-10-11 要求，AJ-491）。
--
-- @why 分类原是写死的四个（023 的 `products_category_domain` CHECK + shared `PRODUCT_CATEGORY` + 契约 enum）：
--      加一个分类要改迁移、契约、三端代码再发版。用户要求"可以增加分类、小程序能识别、没有商品的分类不显示"，
--      参照成熟电商：分类是后台维护的数据（名称、排序、启停），买家端按接口动态展示。
-- @why 键（key）用小写字母开头的短串而不是自增 id：已有商品、Banner 的 `link_id`、小程序埋点都存的是
--      'beauty' 这类键；沿用它就不用迁移这些数据。键建好后**不能改**（只改名称），否则外键与历史埋点对不上。
-- @why `products.category` 改成外键（ON DELETE RESTRICT）：删一个还有商品的分类会被库直接拒——
--      应用层也会先查（给运营说人话），外键是兜底。
-- @why 名称唯一：两个分类叫同一个名字，运营与买家都分不清。
-- @limitation 一：预置的四个分类沿用原键与原中文名（与小程序原 CATEGORY_LABELS 一致）；排序按原顺序 10 / 20 / 30 / 40。
-- @limitation 二：不做多级分类（一级够用，MVP）。
--
-- @breaking ⚠️ up 段 `ALTER TABLE products DROP CONSTRAINT products_category_domain` 与 `ADD CONSTRAINT … FOREIGN KEY`：
--      旧版本代码在迁移完成到新实例接管之间的窗口里仍按四个固定分类写商品——四个键都在新表里预置了，
--      外键对它们照样成立，所以窗口内旧代码的写入不会失败；新键要等新代码上线后才可能出现。
--
-- @see server/src/adapters/categories.ts；server/src/app/admin-category-routes.ts；docs/自主决策记录.md AJ-491

-- Up migration

CREATE TABLE product_categories (
  key         VARCHAR(32) PRIMARY KEY CONSTRAINT product_categories_key_check
                CHECK (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name        VARCHAR(20) NOT NULL CONSTRAINT product_categories_name_check
                CHECK (char_length(btrim(name)) BETWEEN 1 AND 10),
  sort        INTEGER NOT NULL DEFAULT 0 CONSTRAINT product_categories_sort_check
                CHECK (sort BETWEEN 0 AND 9999),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_product_categories_name ON product_categories (name);

INSERT INTO product_categories (key, name, sort) VALUES
  ('beauty', '美妆护肤', 10),
  ('daily', '生活百货', 20),
  ('kitchen', '厨房餐具', 30),
  ('food', '食品', 40);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_domain;
ALTER TABLE products
  ADD CONSTRAINT products_category_fk
  FOREIGN KEY (category) REFERENCES product_categories (key) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- 外键索引（结构不变量）兼作"按分类数在售商品"
CREATE INDEX idx_products_category ON products (category, status);

-- Down migration

DROP INDEX IF EXISTS idx_products_category;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_fk;
ALTER TABLE products
  ADD CONSTRAINT products_category_domain
  CHECK (category IN ('beauty', 'daily', 'kitchen', 'food'));
DROP INDEX IF EXISTS uq_product_categories_name;
DROP TABLE IF EXISTS product_categories;
