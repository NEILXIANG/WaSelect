/**
 * 职责：**支付入口与支付意图**的纯函数（供 `pages/pay` 与 `pages/checkout` 共用）。
 *
 * @why 独立成共享模块而不是塞进支付页：确认订单页要**预取**通道列表（先让用户看到
 *      "可以用什么付"），支付页要**渲染 + 执行**。写两遍的结果是
 *      "确认页说支持银行卡、支付页不显示它"，且不报错。
 *
 * @why **一律不认通道名**（`channel` 是任意字符串，新增支付方式不改契约）：
 *      ① 渲染什么 → 看 `ChannelView.entryMode`；
 *      ② 下一步做什么 → 看 `PaymentIntent.payload` 的**形状**。
 *      按 `channel === 'stripe'` 分支的那天，就是"新增支付方式必须发版"的那天——
 *      正是 ADR-28 要杜绝的。
 *
 * @limitation 一：`redirect` **直接不显示**（而不是显示出来再判不可用）：
 *              它是契约 entryMode 三值之一，但小程序内没有"302 跳出去再回来"的闭环
 *              （D-49 已废 H5 收银页与 web-view）。显示它的结果就是"点了没反应"——
 *              那是本项目认定的最坏形态（看起来能用、实际是坏的），宁可不给入口。
 *              @tradeoff 代价是后台若把某通道配成 redirect，小程序侧**静默没有这个入口**；
 *              可接受，因为 MVP 只会有 in_app（微信）与 copylink（Stripe）两种。
 * @limitation 二：`in_app` 五参数**缺一个就不算 in_app**（不是"少传一个试试"）——
 *              `wx.requestPayment` 少参数的失败是宿主给的黑盒文案，
 *              指向 `requestPayment` 而不是"服务端少返了一个字段"。
 *
 * @see ../../contracts/api-contract.yaml（ChannelView / PaymentIntent）；
 *      ./wx-api.js（requestPayment / setClipboardData 宿主能力）
 */

/** `wx.requestPayment` 需要的五个字段（契约 PaymentIntent.payload 的 wechat 形状）。 */
const WX_PAY_FIELDS = ['timeStamp', 'nonceStr', 'package', 'signType', 'paySign'];

/**
 * `GET /pay/channels` 响应 → 可渲染的通道选项。
 * @why **不重排**：服务端已按 `priority` 排序（契约明说），前端再排一次
 *      就是"两个地方各定一次顺序"，漂移时表现为"后台改了优先级、小程序没变"。
 */
export function channelOptions(resp) {
  const items = resp && typeof resp === 'object' && Array.isArray(resp.items) ? resp.items : [];
  return (
    items
      .filter((c) => c && typeof c === 'object')
      .filter((c) => typeof c.channel === 'string' && c.channel !== '')
      // ⚠️ redirect 不在其中——@see @limitation 一（显示了也走不通，宁可不给入口）
      .filter((c) => c.entryMode === 'in_app' || c.entryMode === 'copylink')
      .map((c) => ({
        channel: c.channel,
        label: typeof c.label === 'string' && c.label !== '' ? c.label : c.channel,
      }))
  );
}

/**
 * `PaymentIntent` → 下一步该做什么（**判别联合**，调用方按 `kind` 穷举）。
 * @param {unknown} intent `POST /orders/{id}/pay` 的响应
 * @returns {{kind: 'auto'} | {kind: 'in_app', params: object} |
 *           {kind: 'copylink', url: string} | {kind: 'unsupported', reason: string}}
 *
 * @why **只看 `payload` 的形状**：契约的 `PaymentIntent` 里**没有** entryMode
 *      （那是 `ChannelView` 的），而 `channel` 是任意字符串。
 *      按形状判的代价是"服务端改了 payload 键名前端要跟着改"，
 *      但那个改动**契约里写得明明白白**（payload 说明逐通道列了形状），不是隐式约定。
 *
 * @why `auto` 判在最前：审核期 mock 通道不需要调起任何东西（0.5.6 更正的形状），
 *      若落到按形状分支会去调一个不存在的支付控件。
 */
export function payPlan(intent) {
  const it = intent && typeof intent === 'object' ? intent : {};
  const payload = it.payload && typeof it.payload === 'object' ? it.payload : {};
  if (payload.auto === true) return { kind: 'auto' };
  if (hasWxPay(payload)) {
    const params = {};
    for (const f of WX_PAY_FIELDS) params[f] = payload[f];
    return { kind: 'in_app', params };
  }
  if (typeof payload.pay_url === 'string' && payload.pay_url !== '') {
    return { kind: 'copylink', url: payload.pay_url };
  }
  return { kind: 'unsupported', reason: '该支付方式当前不可用，请改用其他支付方式' };
}

/** payload 是否齐了 `wx.requestPayment` 五参数。 */
function hasWxPay(payload) {
  return WX_PAY_FIELDS.every((f) => {
    const v = payload[f];
    return typeof v === 'string' ? v !== '' : v !== undefined && v !== null;
  });
}

/**
 * 支付引导文案（银行卡 / copylink 那一屏）。
 * @param {{kind: string, reason?: string, url?: string}} plan `payPlan` 的输出
 *               （`url` 本函数不读，列出来是因为判别联合的调用方会带进来）
 * @why 文案在**这里**而不是 wxml 里写死：D-49 的口径是"短链 → 外部浏览器完成"，
 *      这段话会随 Stripe 托管页的实际表现调整；写在 wxml 里改一次要动 zh/ja 两处。
 */
export function payGuide(plan) {
  const p = plan && typeof plan === 'object' ? plan : {};
  if (p.kind === 'copylink') {
    return {
      title: '请在浏览器中完成支付',
      body: '银行卡支付由 Stripe 托管页完成。复制链接后在浏览器打开，支付完成后回到这里查看订单。',
      actionText: '复制链接',
    };
  }
  if (p.kind === 'auto') {
    return {
      title: '支付已完成',
      body: '本次为审核期测试单，无需真实付款。',
      actionText: '查看订单',
    };
  }
  if (p.kind === 'in_app') {
    // ⚠️ in_app 不需要引导屏：这里返回全空是**信号**不是缺省——wxml 按 title 空与否决定是否渲染
    return { title: '', body: '', actionText: '' };
  }
  return {
    title: '暂时无法支付',
    body: typeof p.reason === 'string' ? p.reason : '该支付方式当前不可用，请改用其他支付方式。',
    actionText: '返回订单',
  };
}
