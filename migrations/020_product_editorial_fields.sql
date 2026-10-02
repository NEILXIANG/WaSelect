-- 020：`products` 增三个**编辑口径**字段——`why` / `maker` / `tags`（S4 前置，AJ-296①）。
--
-- @why 这是 `waselect-design/docs/05-图片与迁移建议.md` §2.3-1 的落地：
--      **在 `why` 落库之前不要迁 `pick-card`**——`why` 是那张卡的灵魂，
--      没有它，迁移过去只会把"纵向编辑大卡"做成一个更高的普通商品卡，比现在更糟。
--
-- @why **三个字段一起加**，而不是只加 `why`：原型 `mock/data.js` 的每一件商品都是
--      `{why, maker, tags}` 三件套同时出现，缺一个时 `pick-card` 的版式会塌一角
--      （名字下面的 maker 是空的、价格下面挂一个空的 tags 行）。
--      ⚠️ 但**只有 `why` 是 S4 的硬前置**：`maker` / `tags` 缺失时前端可以直接不渲染那一块，
--      而 `why` 缺失时整张卡失去存在理由。所以三者同为可选，`why` 单独在契约里标注"降级口径"。
--
-- @why **不复用 `description`**：`description` 是**客观描述**（这个东西是什么），
--      `why` 是**编辑口径**（为什么值得买）。混在一个字段里，将来想分别运营、
--      分别国际化就分不开了——而"分别国际化"是本项目已经有的需求（条款就有 zh/ja/en 三语）。
--
-- @why **不复用 `compliance_tags`**：它管的是"能不能寄"（液体 / 电池 / 含酒精…），
--      取值是**封闭枚举**，上架即拒一部分；本列的 `tags` 管的是"值不值得买"
--      （产地直送 / 终身可用 / 可洗碗机），是**自由文案**给买家看的。
--      两者同名相邻，所以列注释里必须写明分工，否则运营会往 `compliance_tags` 里填营销词。
--
-- @why **全部定为可选（NULL / '[]'）而不是 NOT NULL**：必填会逼运营"随便填一句"交差，
--      首页立刻出现一批"高品质""匠心工艺"式的假文案——这比留白更伤，
--      因为用户旅程地图里明确写着：`why` 退化成口号 → 整个品牌的差异化消失。
--      留白时前端**降级**（不含 why 的形态），不报错、不用通用话术顶上。
--
-- @limitation `why` 用 TEXT 而不是 VARCHAR：`why` 是"一句带判断的话"（如
--            "铸铁蓄热足，水温掉得慢"），长度由编辑自己定；给它一个上限只会让
--            接近上限时被迫删字。真正的约束在**应用层**（`PRODUCT_MAX_CHARS.why`，
--            与 `description` 同一处维护——超限报 40001 而不是静默截断，
--            静默截断会把一句判断截成半句，而半句话读起来像口号）。
-- @limitation `maker` 用 VARCHAR(120)：它是**产地 / 工房名**（"岩手县 · 伝統工芸士 佐藤邸"），
--            是名词不是句子，且要在卡片里单行显示。给它一个列宽上限是"这一行不能溢出"，
--            与 `why` 的性质不同——这也是两者类型不同的原因，不是为了省字节。
-- @limitation 本迁移**不回填历史数据**：当前库里没有商品的 `why` 来源
--            （编辑未撰写），回填只能拿 `description` 抄一份——那正是本迁移要避免的混同。
--            历史商品留空，前端降级，等编辑逐条撰写。
--
-- @see waselect-design/docs/05-图片与迁移建议.md §2.3-1（决策 AJ-296①）；
--      server/src/domain/product-input.ts（长度校验）；
--      server/src/adapters/catalog.ts（买家读路径）；contracts/api-contract.yaml（Product）

-- Up migration

ALTER TABLE products ADD COLUMN IF NOT EXISTS why TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS maker VARCHAR(120);
ALTER TABLE products ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN products.why IS
  '编辑口径的"为什么值得买"（一句带判断的话，不是卖点罗列）。与 `description`（客观描述）'
  '**分工不同**，不可互相顶替。**可选**：留白时前端降级为不含 why 的形态，不用通用话术补位。'
  '长度上限由应用层 `PRODUCT_MAX_CHARS.why` 校验（超限 40001，不静默截断）。';

COMMENT ON COLUMN products.maker IS
  '产地 / 工房 / 匠人名（"岩手县 · 伝統工芸士 佐藤邸"）。可选；留白时前端不渲染这一行。'
  '⚠️ 是**名词**（单行显示的署名），不是句子——这与 `why` 用 TEXT 而本列用 VARCHAR(120) 对应。';

COMMENT ON COLUMN products.tags IS
  '编辑展示标签（"产地直送" / "终身可用" / "可洗碗机"），**自由文案**，给买家看。'
  '⚠️ 与 `compliance_tags` 分工：`compliance_tags` 管"能不能寄"（封闭枚举，上架即拒一部分），'
  '本列管"值不值得买"。两者不可混填——往 compliance_tags 里填营销词会让合规判断失效。';

-- Down migration

COMMENT ON COLUMN products.why IS NULL;
COMMENT ON COLUMN products.maker IS NULL;
COMMENT ON COLUMN products.tags IS NULL;

ALTER TABLE products DROP COLUMN IF EXISTS why;
ALTER TABLE products DROP COLUMN IF EXISTS maker;
ALTER TABLE products DROP COLUMN IF EXISTS tags;
