/**
 * 职责：跨端共享的**输入长度上限**（server / admin-web / 小程序同源引用）。
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
 * @why 与 `SHIPPING_RATE_BOUNDS.maxWeightG` **同值同源**——两者都是"承运商单件上限 30kg"
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
 * @see server/src/domain/product-input.ts；docs/自主决策记录.md AJ-298
 */
export const PRODUCT_MAX_WEIGHT_G = 30_000;

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
  hs_code: 10,
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
export const SHIP_MAX_CHARS = {
  carrier: 32,
  tracking_no: 64,
} as const;
