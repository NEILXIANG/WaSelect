/**
 * 职责：跨端共享的**输入长度上限**（server / admin-web 同源引用）。
 *
 * ⚠️ 曾经写"server / admin-web / **小程序**同源引用"——小程序一项**不成立**：
 *    `miniprogram/` 下没有任何一处引用本文件（它只有两个 `.ts` 用例 import 了 shared 的
 *    另两个模块，与本文件无关）。小程序的表单长度约束目前写在自己的 `utils/` 里。
 *    这不是"要不要让小程序也用"的立场，只是把读者能去哪里找事实写准：
 *    改一个上限时，照旧注释会以为要连带查小程序，而那里其实没有第二份。
 *
 * @why 上限这类数字最会长成"两端各写一份、然后慢慢漂"：服务端拒 500、前端放行 600，
 *      用户填到 550 字被拒，而前端在他填的时候**什么都没提示**——体验上是"提交才炸"，
 *      排查方向却会指向"后端今天抽风"。所以上限必须只有一处定义。
 * @why 放在 shared 而不是服务端：前端需要它做 `maxLength` 与即时校验，
 *      而"前端再写一个 500"恰恰就是本节要防的那件事
 *      （ADR-28：禁写死金额 / 税率 / 国家 / 上限，它们都是配置而不是代码）。
 *
 * @limitation 只放**纯数字常量**，不放校验函数：校验的形态（要不要 trim、
 *      超限是拒绝还是截断、算不算代理对）是各端自己的语义，
 *      塞进共享包会把三种口径压成一个，而压出来的那个一定有一端是错的。
 *
 * @see contracts/api-contract.yaml（对应字段的 maxLength 由契约测试双向比对钉住）；
 *      server/src/domain/admin-order-actions.ts（服务端校验与截断）；
 *      admin-web/src/orders/view.ts（前端校验）；docs/自主决策记录.md AJ-191
 */

/**
 * 退款理由的字符上限（AJ-191 裁决 ⑨ = 500）。
 *
 * @why 500 的依据是 **Stripe metadata 的值上限**：理由会被原样写进
 *      `metadata[reason]`，超了机构直接拒掉这一整笔退款请求。
 *      而它的后果不是"退款失败"这么轻——KD-4（AJ-175）规定人工重试**必须沿用
 *      首次理由**（机构幂等键按订单固定，换理由＝同键异参＝机构 400），
 *      `order_events` 又是 append-only，理由改不了、删不掉，
 *      于是这张单**永久**停在 refunding（B7）。
 *      ⚠️ 换句话说：这个上限不是在保护 Stripe，是在保护"这张订单还有出口"。
 *
 * @limitation 按 **UTF-16 码元**计数（JS 的 `.length`），而 Stripe 按 Unicode
 *      字符计数——两者只在**代理对**（emoji、部分罕用汉字）上不一致：
 *      一个 emoji 我们算 2、机构算 1，于是这类理由会被**提前**拒绝。
 *      这是刻意选的保守方向：少收一个字只是提示早一点，
 *      多收一个字则是上面那整条"永久 refunding"的链条。
 * @limitation ⚠️ 500 是 **Stripe 侧**的上限，不是天然的業務上限。接微信支付
 *      （R1）那天必须复核它的备注字段上限，届时取**更严的那个**——
 *      否则"接了第二个通道，退款突然在第一个通道的上限上被拒"。
 *
 * @see docs/自主决策记录.md AJ-191（裁决 ⑨）；jp《全量逐行代码审查报告-2026-09-29》B7 条
 */
export const REFUND_REASON_MAX_LENGTH = 500;

/**
 * 管理端**备注**（解除拒付限制的理由等进审计台账的自由文本）的字符上限。
 *
 * @why 500 与 `REFUND_REASON_MAX_LENGTH` **同值纯属巧合，不是同一个约束**：
 *      那条是机构 metadata 的**硬**上限（超了机构拒整笔退款），
 *      这条没有任何外部约束，取值只为不让审计行变成一篇长文。
 *      ⚠️ 因此两条**不互相引用**：同值不是同源，改其中一条不该被另一条绊住。
 * @why 2026-10-02 从 `server/src/domain/admin-order-actions.ts` **移进来**：
 *      它原先刻意留在服务端，理由写的是"没有前端消费方，不放进 shared"——
 *      管理端补上「人工解除拒付限制」按钮（AJ-194 的前端待办）之后这个理由不成立，
 *      而前端再写一个 500 就是第三份（文件头 @why 要防的正是这件事）。
 * @limitation 与 `REFUND_REASON_MAX_LENGTH` 同样按 **UTF-16 码元**计数（`.length`）。
 *
 * @see server/src/domain/admin-order-actions.ts（`releaseReasonGuard`）；
 *      admin-web/src/orders/view.ts（`releaseErrors`）；docs/自主决策记录.md AJ-194 / AJ-291
 */
export const ADMIN_NOTE_MAX_LENGTH = 500;

/**
 * 订单**内部备注**（`order_notes.body`，迁移 034）的字符上限（第一批⑤，AJ-396）。
 *
 * @why 1000 而不是复用 `ADMIN_NOTE_MAX_LENGTH`（500）：那条是"一次操作的理由"，一两句话；
 *      内部备注是"把微信里的售后来回记下来"（对标文档 §8-3：买家售后申请立项前用它兜），
 *      常是几段多行文字。两者语义不同，不互相引用（与上面两条同口径：同值不同源，异值更不同源）。
 * @limitation 按 **UTF-16 码元**计（`.length`）；库里的 CHECK 用 `char_length`（码位）≤ 1000，
 *      应用层更严 ⇒ 库约束永远不会先于应用层拒绝（emoji 会被提前拒，方向与退款理由一致）。
 * @see migrations/034_order_notes.sql；server/src/domain/order-note.ts；admin-web/src/orders/OrderNotes.tsx
 */
export const ORDER_NOTE_MAX_LENGTH = 1000;

/**
 * 管理员口令的**最小长度**（12，N11）。
 *
 * @why 它是"下限"而不是"上限"，但同样会长成两份：`config.ts` 用 12 拒启动、
 *      改密脚本用 12 校验，两边写死同一个数字，改一边漏一边的结果是
 *      "脚本设了一个 8 位的口令，下次重启服务直接拒绝启动"——
 *      而这类不一致只在**下一次部署**才暴露，中间还隔着一次真的改密。
 *
 * @limitation 只管长度，不管字符集/强度：强度规则（是否要求大小写数字符号）
 *      属于产品决策，且各端提示文案不同，暂不共享（见文件头 @limitation）。
 *
 * @see server/src/config.ts（启动校验）；scripts/set-admin-password.ts（改密校验）；
 *      docs/自主决策记录.md AJ-209（B17）
 */
export const ADMIN_PASSWORD_MIN_LENGTH = 12;

/**
 * 管理员登录：同一邮箱、**同一来源**连续失败多少次锁定该来源（D-38 ⑤：5 次；AJ-243 起按来源计）。
 * @why 放进 shared（AJ-410，原在 server/src/app/admin-auth-routes.ts）：管理端登录页输错时要提醒"多次输错会锁定"，
 *      数字只能来自同一个常量，前端抄一份 5 / 15 迟早与服务端漂移。服务端仍从 admin-auth-routes.ts 导出同名常量（re-export）。
 */
export const ADMIN_LOGIN_MAX_FAILURES = 5;
/** 管理员登录锁定时长（分钟，D-38 ⑤：15 分钟）。 */
export const ADMIN_LOGIN_LOCK_MINUTES = 15;

/**
 * 展示汇率 `raw_rate` 的 **per-quote 量纲区间**（1 JPY = ? 外币；AJ-297 / 路线图 C7）。
 *
 * @why 分币种看，汇率是**有硬边界的物理量**。⚠️ 既有注释（`admin-web/src/ops/view.ts`）
 *      写的是"绝对值没有合理范围（0.0067 和 0.049 都是对的）"——那个论证**错了**：
 *      0.0067 是 USD、0.049 是 CNY，两者差 7 倍恰恰因为它们是**不同币种**；
 *      它把"跨币种没有一个统一区间"当成了"每个币种都没有区间"。同一个币种从来都有区间。
 * @why 边界取**浮动汇率时代的历史极值再各放宽约 1.7 倍**：
 *      USD/JPY 浮动以来最强 75.8（2011-10）、最弱约 300（1971 前后）⇒ 取 50–500 JPY/USD；
 *      CNY/JPY 近二十年 1 CNY ≈ 12–24 JPY ⇒ 取 6–50 JPY/CNY。
 *      "错一位"是 10 倍 ⇒ 必然越界；真实波动远到不了 1.7 倍 ⇒ 拦得住且不误伤。
 * @why 放在 shared 而不是两端各写一份：`MAX_RAW_RATE = 1000` 此前在
 *      `server/src/domain/fx-input.ts` 与 `admin-web/src/ops/view.ts` 各有一份字面量，
 *      后者注释自称"同源"但改一边忘另一边**不会红**——本常量把那份漂移一并消掉。
 * @limitation 日元若真跌破 **500 JPY/USD**（或涨破 50），正确维护会被拒，
 *              届时改这里一行并重部署。这是刻意的取舍：宁可"极端行情下改一行"，
 *              也不要"日常误录静默入库"——录错一位就是全站展示价同时错 10 倍，
 *              而这类错误在下单前**没有任何症状**。
 * @limitation 新增展示币种（改 `FX_QUOTES`）**必须**同时在这里补区间，
 *              否则该币种没有任何量纲护栏。
 *
 * @see server/src/domain/fx-input.ts（服务端拦截）；admin-web/src/ops/view.ts（前端即时校验）；
 *      docs/自主决策记录.md AJ-297
 */
export const FX_RAW_RATE_BOUNDS: Record<'CNY' | 'USD', { min: number; max: number }> = {
  CNY: { min: 0.02, max: 0.17 },
  USD: { min: 0.002, max: 0.02 },
};

/**
 * 运费档位的**绝对量纲上界**（AJ-297 / 路线图 C7）。
 *
 * @why 30kg：`max_weight_g` 的上界。Japan Post EMS 单件上限 30kg、USPS 国际件更低，
 *      超过它的"档位"在业务上不存在 ⇒ 多打两个 0（2000 → 200000）必是录入错误。
 * @why 10万円：`price_jpy` 的上界。在售商品是 1–3 万円量级，运费超过商品单价数倍的
 *      档位不会上架 ⇒ 这个量级的数字必是误录。
 * @limitation ⚠️ **这两条挡不住"多打一个 0"**：`2000 → 20000`（g）与 `2000 → 20000`（円）
 *      都仍在上界之内，而 20kg / 2万円的档位本身完全合法。
 *      精确抓住 10 倍只能靠"与上一版逐档比较"，而整表替换下这个比较在正常重构
 *      （增删档、调整边界）时假阳性很高，且必须配"确认出口"才不会把"改正上次录错的值"
 *      自己拦住——代价与收益不匹配，故本轮不做的完整理由见 AJ-297。
 *      可观测侧已经够：路由层 `admin_shipping_rates_replaced` 把替换前后**整表逐档**记进日志。
 *
 * @see server/src/domain/shipping-rates-input.ts；docs/自主决策记录.md AJ-297
 */
export const SHIPPING_RATE_BOUNDS = {
  maxWeightG: 30_000,
  priceJpy: 100_000,
} as const;

/**
 * 单件商品的**重量上界**（克；C3-01 DOM3 第二批 / 2026-10-02）。
 *
 * @why 与 `SHIPPING_RATE_BOUNDS.maxWeightG` **同源**（由它推出，见下方余量）——两者都是"承运商单件上限 30kg"
 *      这一个事实的两处兑现：运费档的上界是"能寄多重的一票"，商品重量的上界是
 *      "能寄多重的单件"。写成两个数字就是两份真源，改一处漏一处时
 *      "商品能录 31kg 但运费表最多 30kg"这种矛盾不会报错，只会让含它的购物车 40912。
 * @why 缺它的后果是**静默 + 指向错的人**：商品录成 50000g 能通过全部校验并上架，
 *      但任何把它加进购物车的报价都会取不到档 ⇒ **40912「包裹超重」**——
 *      买家没买几件却看到"包裹超重"，而真正的原因是管理端录错了一个数。
 *      在上架入口拦住，错误才落在能改它的那个人面前。
 * @limitation 它挡的是"单个商品就超重"，**挡不住**"多个商品加起来超重"——
 *              后者是买家的购物车形态，本来就该走 40912。
 * @limitation 若运费表把最大档调到 30kg 以下，仍会出现"商品合法但取不到档"。
 *              彻底的解法是上架时按当前运费表校验，那需要查库（本层是纯函数），
 *              故取常量；这个剩余风险按"配置与商品都应由运营一起维护"接受。
 *
 * @why ⚠️ 2026-10-06 改为"最大档 − 包材余量"（工程缺口第二轮 §3.6 #1）：计费重 = 商品重 + 包材
 *      （`PACKAGING_WEIGHT_G`，默认 250g）。上界原先等于最大档 30 000g，于是 29 751–30 000g 的单件
 *      能上架、却任何购物车都报 40912"包裹超重请拆单"——**单件没法拆**。留 1 000g 余量，
 *      并由 config 规则保证 `PACKAGING_WEIGHT_G ≤` 余量，两边合起来"单件 + 包材"必然落在最大档内。
 *
 * @see server/src/domain/product-input.ts；server/src/config.ts（包材上限规则）；docs/自主决策记录.md AJ-298
 */
export const PRODUCT_PACKAGING_HEADROOM_G = 1_000;
export const PRODUCT_MAX_WEIGHT_G = SHIPPING_RATE_BOUNDS.maxWeightG - PRODUCT_PACKAGING_HEADROOM_G;

/**
 * `products` 表各 VARCHAR 列的**字符上限**（与 001 的列宽逐字一致）。
 *
 * @why 缺列宽校验的后果不是"存不下"，而是 PG 报 **22001** → 兜底层把它折成
 *      泛化的 **40001「参数缺失或格式错误」**（`http.ts` 的 22 类映射）。
 *      运营看到的是"参数有问题"而**不是"这一项太长"**——提示指向了错误的字段，
 *      而管理端表单若不限制长度，她会反复提交反复失败（`banner-input` 文件头
 *      描述的正是这个失效形态）。
 * @why 与 `ADDRESS_MAX_CHARS` 同口径：列宽是 DB 的事实，放在 shared 让服务端与
 *      前端 `maxLength` 共用一处，而不是各写一份然后漂移。
 *
 * @see migrations/001_init.sql（`CREATE TABLE products`）；
 *      server/src/domain/product-input.ts；server/src/domain/address-input.ts（同口径先例）
 */
export const PRODUCT_MAX_CHARS = {
  title: 255,
  // 迁移 031（AJ-386）：10 → 16，带点的美国 10 位 HTS（`3304.99.5000`，12 字）要能存
  hs_code: 16,
  customs_desc_en: 120,
  title_ja: 255,
  jan_code: 13,
  purchase_source: 255,
  /**
   * `products.maker`（VARCHAR(120)，020 迁移新增）：产地 / 工房 / 匠人名。
   *
   * @why 120 与列宽**逐字一致**（其余各键同口径）：这里放宽到 200 的话，
   *      校验会放过 121 字的输入，PG 报 22001 → 兜底折成泛化的 40001，
   *      运营看到"参数有问题"而不是"这一项太长"（本常量存在理由的那条）。
   */
  maker: 120,
  /**
   * `products.why`（TEXT，020 迁移新增）：编辑口径的"为什么值得买"。
   *
   * @why TEXT 列**没有**列宽上限，但**必须**有应用层上限：
   *      ① 无上限时一句 why 可以写满几千字，`pick-card` 的版式会被撑成一整屏文字，
   *         而它本来是"名字下面、价格上面"的**一句**；
   *      ② 超限会撞 PG 的 54000（`string_data_right_truncation` 之外的另一种），
   *         同样被折成泛化的 40001。
   * @why 取 200 而不是更长：`why` 的定义是"**一句**带判断的话"（如
   *      "铸铁蓄热足，水温掉得慢"）。200 字够写两到三句，再长就已经不是"一句"了
   *      ——而"写成卖点罗列"正是用户旅程地图里点名的退化形态（docs/02 §判定）。
   * @limitation 超限报 `why_too_long`（40001）而**不静默截断**：
   *      截断会把一句判断截成半句，而半句话读起来正好像口号——那是最坏的降级结果。
   */
  why: 200,
} as const;

/**
 * `orders` 表**发货两列**的字符上限（`carrier` VARCHAR(32) / `tracking_no` VARCHAR(64)，001）。
 *
 * @why 与 `PRODUCT_MAX_CHARS` **完全同口径**，且这处此前正是那个失效形态的漏网之鱼：
 *      发货入口只判"填没填"不判长度（第二轮审查 B24），超长撞 PG 22001 →
 *      由兜底层折成泛化的 **40001**（`http.ts` 的 22 类映射，reason 带 `sql_data_exception:22001`）。
 *      运营看到的是"参数缺失或格式错误"而**不是"运单号太长"**——提示指向了错误的字段，
 *      她会反复提交反复失败；而发货在事务里，每一次失败都连带把这张单回滚回 paid。
 * @why 32 / 64 与列宽**逐字一致**（不"留点余量"）：放宽到 40 的话，校验放过 33 字的承运商，
 *      结果就是上面那条 40001 又回来了——上限存在的全部理由就是不让 PG 有机会报 22001。
 * @why 放在 shared 而不是服务端：管理端发货表单要 `maxLength` 与即时提示
 *      （与 `ADMIN_NOTE_MAX_LENGTH` 同一条理由——前端再写一个 32 就是第三份）。
 *
 * @see migrations/001_init.sql（`CREATE TABLE orders`）；
 *      server/src/domain/admin-order-actions.ts（`shipInfoGuard`）；
 *      admin-web/src/orders/view.ts（`shipErrors`）；docs/自主决策记录.md AJ-315
 */
/**
 * 低库存阈值（三端联动 UI 模拟 2026-10-08）：库存 ≤ 它的商品在管理端标红，`GET /admin/products?low_stock=true` 只出这些。
 * @why 取 5：代购单件为主、每单 1–3 件，5 件约是一两天的量——再低就来不及从日本补货。
 */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * 库存上限 = Postgres `INT` 上界（`products.stock INT`，AJ-403）。
 * @why 放 shared：服务端 `PATCH /admin/products/{id}/stock` 的入参判定与管理端列表内联改库存的即时提示要同一个数；
 *      前端再写一份 2147483647 就是第二份真源。
 * @limitation 是**技术**上界不是业务上界（手滑 30 → 300000 仍会被接受），见 server/src/domain/stock-patch.ts。
 */
export const PRODUCT_MAX_STOCK = 2_147_483_647;

export const SHIP_MAX_CHARS = {
  carrier: 32,
  tracking_no: 64,
} as const;

/**
 * 批量发货一次最多几单（AJ-401，契约 0.6.45 `POST /admin/orders/ship-batch` 的 `items.maxItems`）。
 *
 * @why 取 50：服务端**逐单一个事务、串行**执行（见 admin-ship-batch-routes.ts @why），一单约一次行锁 + 两条写，
 *      50 单在本机真库上是百毫秒级；再大就开始逼近反代的请求超时（Render / Cloudflare 100 秒级），
 *      而超时 = 前端拿不到逐单结果、后端却已经发了一部分——运营只能逐单打开去核对。
 *      同时它与运营真实的"一次打印一批面单"规模同量级（代购单量日均几十单）。
 * @why 放 shared：管理端勾选 / CSV 导入要在**提交前**就挡住第 51 行（与 SHIP_MAX_CHARS 同一条理由——前端不另写一份）。
 * @limitation 超过上限是**整次拒绝**（40001 batch_too_large），不是"截前 50 单"：静默截断会让第 51 单以后
 *             看起来提交了、其实没发。
 */
export const SHIP_BATCH_MAX = 50;

/**
 * 「导出所选」一次最多几单（AJ-407，契约 0.6.48 `GET /admin/exports/{kind}` 的 `order_ids`）。
 *
 * @why 取 100 = 管理端订单列表 `size` 的上限（契约 `GET /admin/orders` size ≤ 100）：勾选只在当前页内（列表重载即清空），
 *      所以"一页全勾"永远放得下，不会出现"勾得了、导不出"。
 * @why 要有上限：id 走查询串，没有上限时一次请求可以塞几万个 id 进 `in (…)`；
 *      而 URL 长度在反代处另有上限（常见 8KB 级，未实测本部署），超了是网关 414、不是我们的 40001——给出确定的上限，错误码才可预期。
 *      100 × 最长 64 字 ≈ 6.5KB，仍在常见上限内；实际订单 id 远短于 64 字。
 * @limitation 超过上限整次拒绝（40001），不截断——与 SHIP_BATCH_MAX 同一条理由。
 */
export const EXPORT_IDS_MAX = 100;

/**
 * 列表**搜索词**（`keyword`）的字符上限（64；AJ-360 / 第二轮审查 CAT2-07）。
 *
 * @why 它是**唯一**一个客户端可控、且原样进 `ILIKE '%' || kw || '%'` 的输入：
 *      无上限时一次请求可以让 PG 拿着几 KB 的模式串去逐行匹配（`products.keyword`
 *      没有索引，CAT-19 已登记），而 `GET /products` **既不鉴权也不限流**
 *      （读路径配额按 U7 有真实流量数据后再定，理由见 AJ-360）
 *      ⇒ "刷长 keyword"是今天唯一能把连接池（`max: 10`，与支付回调共用）占住的手段。
 *      它同时也是 CAT2-03 那条链（客户端可控长串进日志）里唯一还活着的一条：
 *      日志侧已由 `capForLog` 截断（AJ-356），SQL 侧的成本只能靠上限挡。
 * @why 取 **64** 而不是更短：真实搜索词是"南部鉄器"/"抹茶"这种 2–6 字；
 *      管理端那侧搜的是 单号 / 收件人 / **运单号**，而运单号的上限本身就是
 *      `SHIP_MAX_CHARS.tracking_no = 64`——取同一个数，"整串粘贴运单号去搜"永远搜得全。
 *      再短就会开始误伤"粘贴一整串"这个真实动作，而再长没有任何收益
 *      （没有人的搜索词超过 64 字，超过的一定是脚本）。
 * @limitation 它**不是**存储上限（keyword 不落库），所以不与任何列宽对齐——
 *              这是它与本文件其余常量的唯一区别：那些是"不这么定就存不下"，
 *              这一条是"不这么定会白烧一次全表扫"。
 * @limitation 两端的搜索框（admin-web `OrdersPage` 的输入、小程序 home 的搜索输入）
 *              目前**没有**接这个常量：输入时不截断、提交时也没有即时提示，
 *              超限的表现是**提交后** 40001（reason `keyword_too_long`）。
 *              这与文件头 @why 想防的"前端再写一份上限"不冲突——那里要防的是
 *              **两份**上限，而这里是**零份**，等要补即时提示时直接引用本常量即可。
 *
 * @see contracts/api-contract.yaml（`GET /products` 与 `GET /admin/orders` 的 keyword）；
 *      server/src/app/product-routes.ts；server/src/app/admin-order-routes.ts；
 *      docs/自主决策记录.md AJ-360
 */
export const SEARCH_KEYWORD_MAX_LENGTH = 64;

/**
 * 每个买家最多保存多少条收货地址（工程缺口第二轮 §6.3 G8，AJ-384）。超出 → 40917。
 * @why 地址新增没有限流也没有上限：一个账号就能写入任意多行；而地址簿越长，买家下单时选错地址的概率越高
 *      （跨境寄错一次的代价是整单退回）。20 条远超真实需求（家、公司、亲友），又足以挡住滥用。
 * @limitation 只管条数，不管写入频率；频率限制仍是登记项（G8 后半）。
 */
export const MAX_ADDRESSES_PER_USER = 20;

/**
 * 撤销发货的时间窗（小时，AJ-440）：发货后未满这么多小时才能撤销（恰好到点起拒）。
 * @why 放 shared：服务端闸门（`revertShipmentGuard`）与管理端按钮（`shipmentRevertGate`）读同一个数，
 *      前端写一份 72 就是第二份，改一处忘一处时按钮可点、服务端却拒。
 * @see server/src/domain/admin-order-actions.ts（取值理由与取舍写在那里）
 */
export const SHIPMENT_REVERT_WINDOW_HOURS = 72;
