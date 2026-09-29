/**
 * 职责：确认订单页（`pages/checkout`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 这一页是整条链路里**最容易静默出错**的一页：
 *      ① 拿购物车快照价当合计 → 价格变了没人发现（cart-store @limitation 一）；
 *      ② 建单不带 `expected_total_jpy` → 失去"用户看到的 ≠ 服务端算的"这道防线（40905）；
 *      ③ 提交闸门禁用却不说原因 → 被读成"这站坏了"。
 *      这三条没有一条会报错，只会"看起来成功了"。
 *      （幂等键那条已下沉到 `utils/idempotency.js`：确认页与支付页共用。）
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
 * @param {{itemCount: number, addressId: string, termsAccepted: boolean, totalJpy: number|null,
 *          emailError?: string}} state
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
  // 选填邮箱填错了才拦（AJ-180）：排在最后——前四项是"能不能下单"，这一项只是"填的东西对不对"
  if (typeof s.emailError === 'string' && s.emailError !== '')
    return { ok: false, reason: s.emailError };
  return { ok: true, reason: '' };
}

/** 邮箱错误文案（与服务端 `contact_email_shape` 40001 同一件事，给用户看的版本）。 */
const EMAIL_ERROR = '邮箱格式不正确（可留空）';

/**
 * 结算页"收货通知邮箱（选填）"输入 → 要发的值与错误（PRD §3 确认订单 / D-39；提审前必须，AJ-180）。
 * @param {unknown} raw 输入框原值
 * @returns {{value: string, error: string}} value 为空串 = 不带 contact_email
 * @why 口径与服务端入口（order-routes.ts contact_email）逐条一致：有 @、无空白、≤255；
 *      不发明更严的邮箱正则——前端比服务端严，会拒掉服务端能收的地址；比服务端松，就是"提交后才报错"。
 * @why 首尾空白先去掉：输入法与粘贴常带空格，这不是用户想表达的内容。
 */
export function contactEmailOf(raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === '') return { value: '', error: '' };
  const ok = v.length <= 255 && /^[^\s@]+@[^\s@]+$/.test(v);
  return ok ? { value: v, error: '' } : { value: '', error: EMAIL_ERROR };
}

/**
 * 结算页该用哪个地址（全量审查 A6，2026-09-29）。
 *
 * @param {{picked?: string, current?: string, list?: Array<{id?: string}>, fallback?: string}} args
 *   `picked`  地址页回传的一次性选择（读走即清空）；
 *   `current` 页面当前持有的选择；
 *   `fallback` 两者都用不上时的回落（薄壳传 `defaultAddressId(list)`）；
 *   `list`    `GET /addresses` 的响应（只用来判断某个 id 是否还在列表里）。
 * @returns {string} 选中的地址 id；没有地址时为空串。
 *
 * @why 优先级必须是 **picked > current > fallback** 三段，缺了 `current` 这一段就会
 *      出现 A6 那个缺陷：每次 `onShow` 都会重算地址，而一次性 `picked` 在第一次就被读走清空了，
 *      于是此后每一次返回结算页都回落到默认地址——用户选了非默认地址 B 之后，
 *      **点"查看条款全文"再返回、进地址页没选就返回、或把小程序切到后台再回来**，
 *      地址就静默回到 A，提交后按 A 发货。页面显示的是 A，而用户已经选过一次，
 *      大多不会再核对。跨境改址要走人工，还有重发成本。
 *
 * @why `current` 也要过一遍"仍在列表里"的检查：用户在别处（或另一个标签页）
 *      把当前地址删掉之后，`current` 是一个已经不存在的 id，
 *      继续用它会让 `orderBody` 带一个服务端必然 40400 的 `address_id`。
 *
 * @limitation 只做"选哪个"，**不做默认地址的判定**：默认逻辑（`is_default` / 第一条）
 *              住在 `utils/address-form.js` 的 `defaultAddressId`，由薄壳算好传进 `fallback`。
 *              在这里再写一份就会变成第二份真源（约束九）。
 */
export function resolveAddressId(args) {
  const a = args && typeof args === 'object' ? args : {};
  const list = Array.isArray(a.list) ? a.list : [];
  const inList = (id) => typeof id === 'string' && id !== '' && list.some((x) => x && x.id === id);
  if (inList(a.picked)) return a.picked;
  if (inList(a.current)) return a.current;
  return typeof a.fallback === 'string' ? a.fallback : '';
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
