/**
 * 职责：确认订单页（`pages/checkout`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 这一页是整条链路里**最容易静默出错**的一页：
 *      ① 拿购物车快照价当合计 → 价格变了没人发现（cart-store @limitation 一）；
 *      ② 建单不带 `expected_total_jpy` → 失去"用户看到的 ≠ 服务端算的"这道防线（40905）；
 *      ③ 提交闸门禁用却不说原因 → 被读成"这站坏了"。
 *      这三条没有一条会报错，只会"看起来成功了"。
 *      （幂等键那条已下沉到 `utils/idem-key.js`：确认页与支付页共用。）
 *
 * @why **不含**支付相关函数：支付方式渲染与"下一步做什么"住在 `utils/pay-plan.js`——
 *      确认页要**预取**通道列表（先让用户看到可以用什么付），支付页要**执行**，
 *      两边共用同一份纯函数，才不会出现"确认页说支持、支付页不显示"。
 *
 * @limitation 一：商品行**刻意不带价格**。价格只信 `POST /orders/quote`，
 *              一旦行里出现价格字段，就会有人拿它算合计（快照价会过期）。
 *
 * @see ../../utils/cart-store.js（本地状态）；../../utils/pay-plan.js（支付部分）；
 *      ../../../contracts/api-contract.yaml（Quote / OrderCreated / POST /orders）
 */

/** 商品行（**不带价格**：价格只信 quote，@see @limitation 一）。 */
export function itemRows(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => i && typeof i.productId === 'string' && i.productId !== '')
    .map((i) => ({
      productId: i.productId,
      title: typeof i.title === 'string' ? i.title : '',
      qty: Number.isInteger(i.qty) ? i.qty : 1,
    }));
}

/**
 * 能否提交（按钮禁用 + 原因）。
 * @param {{itemCount: number, addressId: string, termsAccepted: boolean, totalJpy: number|null}} state
 * @returns {{ok: boolean, reason: string}}
 * @why 返回**原因**而不是只给 ok：禁用但不说为什么的按钮会被读成"这站坏了"，
 *      而原因文案必须由逻辑给（wxml 里写死一串 `wx:if` 会让四条判断各漂移一次）。
 */
export function submitGate(state) {
  const s = state && typeof state === 'object' ? state : {};
  if (!Number.isInteger(s.itemCount) || s.itemCount < 1)
    return { ok: false, reason: '购物车是空的' };
  if (typeof s.addressId !== 'string' || s.addressId === '')
    return { ok: false, reason: '请选择收货地址' };
  if (s.termsAccepted !== true) return { ok: false, reason: '请先阅读并同意购买条款' };
  if (!Number.isInteger(s.totalJpy)) return { ok: false, reason: '运费与合计还在计算中' };
  return { ok: true, reason: '' };
}

/**
 * 组装 `POST /orders` 请求体。
 * @param {{items: Array, addressId: string, termsVersion: string,
 *          expectedTotalJpy?: number|null, contactEmail?: string}} args
 * @why `terms_version` / `address_id` 缺失**直接抛**而不是发出去：
 *      服务端一律拒单（D-43 条款版本不一致即 40011），
 *      晚失败的表现是"点了提交转一圈然后失败"，早失败至少能指到"没拿到条款版本"。
 * @limitation 二：`expected_total_jpy` **有才带**（quote 还没回来时不带）。
 *              它是防线不是必填项：带 null 会被类型校验拒；
 *              没有合计时这一道防线降级（服务端照算），但不阻塞下单。
 */
export function orderBody(args) {
  const a = args && typeof args === 'object' ? args : {};
  if (typeof a.termsVersion !== 'string' || a.termsVersion === '') {
    throw new Error('orderBody：terms_version 不能为空（GET /terms 没拿到版本就不是提交时机）');
  }
  if (typeof a.addressId !== 'string' || a.addressId === '') {
    throw new Error('orderBody：address_id 不能为空');
  }
  const body = {
    items: itemRows(a.items).map((i) => ({ product_id: i.productId, qty: i.qty })),
    address_id: a.addressId,
    terms_version: a.termsVersion,
  };
  if (Number.isInteger(a.expectedTotalJpy)) body.expected_total_jpy = a.expectedTotalJpy;
  if (typeof a.contactEmail === 'string' && a.contactEmail !== '')
    body.contact_email = a.contactEmail;
  return body;
}
