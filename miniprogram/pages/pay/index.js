/**
 * 职责：支付页薄壳——拉通道 → 选通道 → `POST /orders/{id}/pay` → 按 `payPlan` 执行。
 *
 * @why 支付方式**一律由服务端下发**（`GET /pay/channels`）并按 `entryMode` 分流，
 *      前端不写死通道名、不写死按钮：上下线一个通道改配置即可，无需发版（ADR-28/F11）。
 *      ⚠️ 这是本项目"可扩展性"的硬要求，不是风格偏好——
 *      按 `channel === 'stripe'` 分支的代码在新增支付方式那天必须改前端重新提审。
 *
 * @why `amount_jpy` 从 `GET /orders/{id}` 取而不是从上一页带过来：
 *      金额是**服务端权威**数据，跨页传参意味着"页面上显示的金额可以被改包篡改"，
 *      而通道过滤正是按金额做的（大额可能不开放某些通道）。
 *
 * @limitation 一：**没有轮询支付结果**。支付完成靠服务端回调（`/pay/callback/{channel}`），
 *              前端不知道何时完成。copylink 场景（浏览器里付）更是无法感知——
 *              所以引导屏只给"支付完成后回到这里查看订单"，不假装有实时状态。
 *              @tradeoff 代价是用户要自己回来看；MVP 可接受（回调落库后订单页即是真值）。
 * @limitation 二："查看订单"按钮当前禁用——`pages/order` 未落地，
 *              跳一个不存在的页面 = "看起来能用、实际是坏的"（与首页/详情同一条原则）。
 * @limitation 三：`requestPayment` 的**取消与失败一视同仁**（wx-api @limitation 十）：
 *              两者都停在支付页，订单仍是 pending_payment，用户可再点一次。
 *              解析宿主 fail 的文案去区分"取消 vs 失败"等于把宿主文案当契约。
 *
 * @see ../../utils/pay-plan.js（通道渲染 / 实扣金额与 §14.2 提示条 / 下一步做什么）；
 *      ../../utils/address-form.js（ADDRESS_COUNTRY_DEFAULT：通道过滤的目的国）
 */
import {
  CHARGE_CURRENCY_ORDER,
  chargeOptions,
  payGuide,
  payNotice,
  payPlan,
} from '../../utils/pay-plan.js';
import { ADDRESS_COUNTRY_DEFAULT } from '../../utils/address-form.js';
import { newIdemKey } from '../../utils/idem-key.js';
import { errorMessage } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 订单列表页路径（跳转路径只在这一处出现）。 */
const ORDER_PAGE = '/pages/order/index';

Page({
  data: {
    /** `chargeOptions` 的输出：每个通道带实扣币种与金额（§14.2，AJ-180）。 */
    channels: [],
    /** §14.2 支付前提示条（逐行文案；空数组 = 不渲染）。 */
    notice: [],
    /** 订单合计（JPY 整数）；null = 还没拿到。 */
    totalJpy: null,
    /** 引导屏文案（copylink / auto / unsupported）；title 空串 = 不渲染引导屏。 */
    guide: { title: '', body: '', actionText: '' },
    /** copylink 的短链（D-49：银行卡唯一入口）。 */
    payUrl: '',
    loading: false,
    paying: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
  },

  /** 订单 id（空串 = 没带过来，此时不取数）。 */
  orderId: '',
  /** 本次发起支付的幂等键（重试复用，同 checkout 的口径）。 */
  idemKey: '',
  traceId: '',

  /** @param {{orderId?: string}} options 结算页带来的 `?orderId=…` */
  onLoad(options) {
    this.traceId = newTraceId();
    this.orderId = typeof options?.orderId === 'string' ? options.orderId : '';
    if (this.orderId === '') {
      this.setData({ error: '缺少订单 id' });
      return;
    }
    void this.load();
  },

  /**
   * 取订单（拿权威金额）→ 按扣款币种顺序逐个取通道（按金额过滤）。串行：后者依赖前者的金额。
   * @why 逐币种查（CHARGE_CURRENCY_ORDER）而不是只查 JPY：只对外声明 USD 的银行卡通道只在 USD 下列出，
   *      只查 JPY 时它**永远不出现**（AJ-180）。
   */
  async load() {
    this.setData({ loading: true });
    try {
      const order = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}`,
        traceId: this.traceId,
      });
      const total = Number.isInteger(order?.total_jpy) ? order.total_jpy : null;
      this.setData({ totalJpy: total });
      if (total === null) {
        this.setData({ error: '订单金额还没确定，请稍后再试' });
        return;
      }
      const listings = [];
      for (const currency of CHARGE_CURRENCY_ORDER) {
        const resp = await app.globalData.api({
          url: `${app.globalData.apiBase}/api/v1/pay/channels?country=${ADDRESS_COUNTRY_DEFAULT}&currency=${currency}&amount_jpy=${total}`,
          traceId: this.traceId,
        });
        listings.push({ currency, resp });
      }
      const channels = chargeOptions(listings, order);
      this.setData({ channels, notice: channels.length > 0 ? payNotice(channels, order) : [] });
    } catch (e) {
      this.setData({ error: errorMessage(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 选一个通道 → 发起支付。 */
  onPay(e) {
    const channel = e?.currentTarget?.dataset?.channel;
    if (typeof channel !== 'string' || channel === '') return;
    this.idemKey = newIdemKey();
    void this.startPay(channel);
  },

  async startPay(channel) {
    this.setData({ paying: true, error: '' });
    try {
      const intent = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}/pay`,
        method: 'POST',
        data: { channel },
        idempotencyKey: this.idemKey,
        traceId: this.traceId,
      });
      this.run(intent);
    } catch (err) {
      this.setData({ error: errorMessage(err) });
    } finally {
      this.setData({ paying: false });
    }
  },

  /** 按 `payPlan` 的判别联合执行（**不认通道名**，@see 文件头）。 */
  run(intent) {
    const plan = payPlan(intent);
    if (plan.kind === 'in_app') {
      wxApi.requestPayment({
        ...plan.params,
        // @see @limitation 三：取消与失败都不做特殊处理，停在支付页即可
        fail: (err) => this.setData({ error: errorMessage(err) }),
      });
      return;
    }
    if (plan.kind === 'copylink') {
      // ⚠️ 不自动复制：剪贴板是用户的东西，未经动作就改写它是越界。用户点"复制链接"再复制。
      this.setData({ payUrl: plan.url, guide: payGuide(plan) });
      return;
    }
    this.setData({ guide: payGuide(plan) });
  },

  /** 复制短链到剪贴板（D-49：银行卡唯一入口 = 短链 → Stripe Checkout 托管页）。 */
  onCopy() {
    if (this.data.payUrl === '') return;
    wxApi.setClipboardData({ data: this.data.payUrl });
  },

  /**
   * 去订单列表（copylink 场景的"支付完成后回到这里查看订单"）。
   * @why 用 `redirectTo` 而不是 `navigateTo`：支付页不该留在返回栈里——
   *      从订单列表按返回键又回到"请在浏览器完成支付"那一屏是明显的死循环感，
   *      而订单已经建好了，支付页的历史使命结束。
   */
  onViewOrders() {
    wxApi.redirectTo({ url: ORDER_PAGE });
  },
});
