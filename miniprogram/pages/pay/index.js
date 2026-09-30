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
 * @limitation 四：幂等键**一次意图一个、重试复用**（`intentKey.acquire()`），
 *              与结算页同一口径（A5，2026-09-29）。两处会作废键：
 *              **换通道**（同键重放会拿回上一个通道的凭据）与支付已发起成功。
 *              发起失败**不**作废——弱网下用户再点一次必须还是同一个键，
 *              否则同一张单会发起两次支付。
 * @limitation 五：**在途不再发起**（B6 / AJ-201）：上一次 `POST /orders/{id}/pay`
 *              还没回来时点第二个通道/再点一次，直接不动。服务端有幂等键兜底
 *              （同键不会建第二个会话），但发起支付要调机构、一次最长 6s，
 *              连接池只有 10 条时连点就是自己把自己排队——这里挡的是浪费，不是正确性。
 *
 * @see ./index.vm.js（点一下该做什么：纯函数，约束十一）；
 *      ../../utils/pay-plan.js（通道渲染 / 实扣金额与 §14.2 提示条 / 下一步做什么）；
 *      ../../utils/idempotency.js（幂等键生命周期）；
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
import { createIntentIdempotency } from '../../utils/idempotency.js';
import { errorMessage } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import {
  PAY_FAIL_TEXT,
  copyResult,
  payPageView,
  payStartDecision,
  shouldRefreshOnShow,
} from './index.vm.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 订单列表页路径（跳转路径只在这一处出现）。 */
const ORDER_PAGE = '/pages/order/index';

/** 订单详情页路径（支付成功后去这里：这一单的最新真值在详情页，不在本页）。 */
const ORDER_DETAIL_PAGE = '/pages/order-detail/index';

Page({
  data: {
    /** `chargeOptions` 的输出：每个通道带实扣币种与金额（§14.2，AJ-180）。 */
    channels: [],
    /** §14.2 支付前提示条（逐行文案；空数组 = 不渲染）。 */
    notice: [],
    /** 订单已不可支付时的说明（空串 = 正常列通道；B35 / AJ-218）。 */
    closedText: '',
    /** 订单合计（JPY 整数）；null = 还没拿到。 */
    totalJpy: null,
    /** 引导屏文案（copylink / auto / unsupported）；title 空串 = 不渲染引导屏。 */
    guide: { title: '', body: '', actionText: '' },
    /** copylink 的短链（D-49：银行卡唯一入口）。 */
    payUrl: '',
    /** 短链是否已复制成功（决定按钮文案；失败由 `error` 显示并给兜底动作）。 */
    copied: false,
    loading: false,
    paying: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
  },

  /** 订单 id（空串 = 没带过来，此时不取数）。 */
  orderId: '',
  /** 幂等键的生命周期器（重试复用，同 checkout 的口径）。 */
  intentKey: null,
  /** 上一次发起支付用的通道（空串 = 还没发起过）。 */
  lastChannel: '',
  traceId: '',
  /** 是否已经取过一次数（`onShow` 的刷新只对"第二次及以后"生效，避免进页面取两遍）。 */
  loaded: false,

  /** @param {{orderId?: string}} options 结算页带来的 `?orderId=…` */
  onLoad(options) {
    this.traceId = newTraceId();
    this.intentKey = createIntentIdempotency();
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
      // B35 / AJ-218：已付 / 已关 / 已退款的单**不列支付方式**（点了就是 40902）
      const view = payPageView(order);
      this.setData({ totalJpy: total, closedText: view.closedText });
      if (!view.payable) {
        this.setData({ channels: [], notice: [] });
        return;
      }
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
      // 首屏由 onLoad 触发；`onShow` 的刷新只对"已经取过一次"之后生效
      // （微信里 onLoad 与 onShow 会连着各触发一次，不挡就是每次进页面取两遍）
      this.loaded = true;
    }
  },

  /**
   * 从后台或上一页回来时重新取数（B35 / AJ-218）。
   * @why 支付完成的真值在服务端回调里，本页不轮询；用户去浏览器付完款再回来，
   *      只有重新取数才能把"已付款"显示出来——否则支付方式按钮还挂着，点了就是 40902。
   *      判断在 `shouldRefreshOnShow`（copylink / 引导屏 / 在途 三种情况不刷新）。
   */
  onShow() {
    if (this.loaded !== true) return;
    if (this.orderId === '') return;
    if (
      !shouldRefreshOnShow({
        payUrl: this.data.payUrl,
        guideTitle: this.data.guide?.title,
        paying: this.data.paying,
      })
    ) {
      return;
    }
    void this.load();
  },

  /** 选一个通道 → 发起支付。判断全在 `index.vm.js`（约束十一：薄壳只做编排）。 */
  onPay(e) {
    const decision = payStartDecision({
      paying: this.data.paying === true,
      channel: e?.currentTarget?.dataset?.channel,
      lastChannel: this.lastChannel,
      hasKey: this.intentKey !== null,
    });
    if (decision.kind === 'ignore') return;
    // ⚠️ 换通道 = 请求参数变了：沿用旧键会被服务端**重放成上一个通道的 intent**，
    //    用户点了 B 却拿到 A 的支付凭据（同键同参才算重放，参数不同就不是）。
    //    必须在 acquire **之前**作废，否则拿到的是旧键。
    if (decision.retireKey) this.intentKey.retire();
    this.lastChannel = decision.channel;
    const { key } = this.intentKey.acquire();
    void this.startPay(decision.channel, key);
  },

  async startPay(channel, idemKey) {
    this.setData({ paying: true, error: '' });
    try {
      const intent = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}/pay`,
        method: 'POST',
        data: { channel },
        idempotencyKey: idemKey,
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
        // B35 / AJ-218：成功必须**离开这一页**——以前没有 success 回调，
        // 微信支付成功后页面纹丝不动，用户再点一次得 40902（订单其实已经付了）。
        // 用 redirectTo 而不是 navigateTo：支付页不该留在返回栈里
        // （@see onViewOrders 同一条理由；订单已建好，这一页的历史使命结束）。
        success: () =>
          wxApi.redirectTo({
            url: `${ORDER_DETAIL_PAGE}?orderId=${encodeURIComponent(this.orderId)}`,
          }),
        // @see @limitation 三：取消与失败一视同仁。⚠️ 但不走 errorMessage——
        // 宿主 fail 的形状是 {errMsg}，读出来是 "requestPayment:fail cancel" 这种黑盒文案，
        // 把"用户主动取消"显示成"加载失败"会让人以为付款出了故障。
        fail: () => this.setData({ error: PAY_FAIL_TEXT }),
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

  /**
   * 复制短链到剪贴板（D-49：银行卡唯一入口 = 短链 → Stripe Checkout 托管页）。
   *
   * @why **必须传 success / fail**（B34 / AJ-217）：`setClipboardData` 是隐私接口，
   *      用户拒绝隐私弹窗或隐私指引漏声明剪切板时会失败；此前不传回调的表现是
   *      "点了没反应"，而这一屏在微信支付上线前是**唯一的付款路径**——
   *      用户唯一的结论是"付不了款"。失败时给出兜底动作（长按链接），
   *      链接文本本身也在页面上（`user-select`，见 index.wxml）。
   * @limitation 失败文案由 `copyResult` 产出（约束十一：文案不在薄壳里写死）。
   */
  onCopy() {
    if (this.data.payUrl === '') return;
    wxApi.setClipboardData({
      data: this.data.payUrl,
      success: () => this.setData(copyResult(true)),
      fail: () => this.setData(copyResult(false)),
    });
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
