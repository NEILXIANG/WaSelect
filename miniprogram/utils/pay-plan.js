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

import { formatJpy, formatUsdCents } from './price-format.js';

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

/**
 * 通道列出查询的币种顺序 = 扣款币种的判定顺序（§14.2，AJ-180）。
 * @why 与服务端 `pay-intent.ts` 的 resolveCharge 同口径："通道在该币种下**对外可见**"才会按该币种扣，
 *      JPY 锚优先、其次 USD。曾经支付页只按 JPY 查——只声明 USD 的银行卡通道（stripe）**永远不出现**，
 *      而微信支付要等 R1 才上线：那段时间小程序里一个支付入口都没有，且不报任何错。
 * @limitation 这是服务端规则在前端的**一份复述**（契约 ChannelView 不带扣款币种）；
 *             服务端改判定顺序时这里要跟着改。`stripe-golden-chain.db.test.ts`「§14.2」用真路由钉住
 *             "按这个顺序查到的第一个币种 = 发起支付时实际扣的币种"，漂移会先在那里红。
 */
export const CHARGE_CURRENCY_ORDER = ['JPY', 'USD'];

/**
 * 按 CHARGE_CURRENCY_ORDER 分别查到的通道列表 → 带实扣币种与金额的支付选项（§14.2）。
 * @param {unknown} listings `[{currency, resp}]`，resp 为 `GET /pay/channels` 响应
 * @param {unknown} order `GET /orders/{id}` 响应（读 total_jpy / display）
 * @returns {Array<{channel: string, label: string, entryMode: string,
 *           charge: {currency: string, amount: number|null, text: string}, buttonText: string}>}
 * @why 同一通道在多个币种下都列出时**先到先得**（与服务端同样取 JPY），不重复出现。
 * @why 美元金额取订单的 `display.USD`：它与服务端扣款用的是同一个换算（订单自己的 fx_snapshot → toMinor），
 *      不在前端再乘一次汇率；缺了就不编数字（amount=null，文案指向支付页）。
 * @limitation 顺序：先 JPY 列出的、再只在 USD 下列出的；ChannelView 不带 priority，跨币种无法按优先级合并。
 */
export function chargeOptions(listings, order) {
  if (!Array.isArray(listings)) return [];
  const o = order && typeof order === 'object' ? order : {};
  const seen = new Set();
  const out = [];
  for (const l of listings) {
    const currency = l && typeof l === 'object' ? l.currency : undefined;
    if (currency !== 'JPY' && currency !== 'USD') continue;
    const items = l.resp && Array.isArray(l.resp.items) ? l.resp.items : [];
    for (const c of items) {
      if (!c || typeof c !== 'object' || typeof c.channel !== 'string' || c.channel === '')
        continue;
      if (c.entryMode !== 'in_app' && c.entryMode !== 'copylink') continue;
      if (seen.has(c.channel)) continue;
      seen.add(c.channel);
      const label = typeof c.label === 'string' && c.label !== '' ? c.label : c.channel;
      const charge = chargeOf(currency, o);
      out.push({
        channel: c.channel,
        label,
        entryMode: c.entryMode,
        charge,
        buttonText: charge.amount === null ? label : `${label}（${charge.text}）`,
      });
    }
  }
  return out;
}

/** 单个币种的实扣金额与文案（chargeOptions 的一部分）。 */
function chargeOf(currency, order) {
  if (currency === 'JPY') {
    const jpy = Number.isInteger(order.total_jpy) ? order.total_jpy : null;
    return {
      currency,
      amount: jpy,
      text: jpy === null ? '日元（金额以支付页为准）' : formatJpy(jpy),
    };
  }
  const usd = order.display && Number.isInteger(order.display.USD) ? order.display.USD : null;
  return {
    currency,
    amount: usd,
    text: usd === null ? '美元（金额以支付页为准）' : formatUsdCents(usd),
  };
}

/** 币种 → 提示条里的中文名。 */
const CURRENCY_NAME = { JPY: '日元', USD: '美元' };

/**
 * §14.2 支付前提示条（官方《小程序平台运营规范》§14.2："执行支付动作前，需在页面中对用户有明确的提示"，D-48）。
 * @param {ReturnType<typeof chargeOptions>} options
 * @param {unknown} order 读 created_at / expires_at（只做两个时刻相减，**不取"现在"**——F10 同口径）
 * @returns {string[]} 逐行文案：各通道实扣币种与金额 → copylink 离开微信 → 超时关单
 * @why 关单分钟数由订单自己的两个时刻算，而不是写死 30：TTL 是服务端配置（ORDER_PAYMENT_TTL_MIN），
 *      写死就是"改了配置、提示还说 30 分钟"。
 */
export function payNotice(options, order) {
  const opts = Array.isArray(options) ? options : [];
  const lines = [];
  for (const o of opts) {
    const name = CURRENCY_NAME[o.charge.currency] ?? o.charge.currency;
    lines.push(
      o.charge.amount === null
        ? `${o.label}：将以${name}扣款（金额以支付页为准）`
        : `${o.label}：将以${name}扣款 ${o.charge.text}`,
    );
  }
  for (const o of opts) {
    if (o.entryMode === 'copylink') {
      lines.push(`选择「${o.label}」将离开微信，复制链接后在 Safari / Chrome 等浏览器中完成支付`);
    }
  }
  const ord = order && typeof order === 'object' ? order : {};
  const ttlMs = Date.parse(String(ord.expires_at)) - Date.parse(String(ord.created_at));
  lines.push(
    Number.isFinite(ttlMs) && ttlMs > 0
      ? `订单 ${Math.round(ttlMs / 60_000)} 分钟内未支付将自动关闭`
      : '订单超时未支付将自动关闭',
  );
  return lines;
}
