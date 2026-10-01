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
