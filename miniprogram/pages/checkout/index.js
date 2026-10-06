/**
 * 职责：确认订单页薄壳——购物车 + 地址 + 报价 + 条款 → `POST /orders` → 跳支付页。
 *
 * @why 三条取数（`/terms` `/addresses` `/orders/quote`）**并发**而不是串行：
 *      它们互不依赖，串行会多等两个往返；而"点进结算页要转三秒"是最直观的流失点。
 *      ⚠️ 但 `expected_total_jpy` 必须等 quote 回来才有——所以提交闸门里
 *      有"运费与合计还在计算中"这一档（vm 的 `submitGate`），不是靠串行规避。
 *
 * @why 地址预选走 `defaultAddressId` + 一次性 `pickedAddressId`：
 *      用户八成用默认地址，每次都要点一次选择是纯粹的浪费；
 *      而"选了别的"要能生效，所以地址页回传的选择**优先于**默认。
 *      ⚠️ 读走后**立刻清空**：留着会让下一次进结算页拿到过期的选择。
 *
 * @limitation 一：建单成功**立刻清空购物车**——购物车是本地状态，
 *              不清的表现是"下单了购物车还有东西"，用户会再下一单。
 *              支付失败不影响：订单已存在（pending_payment），去订单页可继续付。
 * @limitation 二：幂等键**一次提交一个**，重试复用同一个——
 *              每次重试都换键的话，网络一抖就建出两张单，而用户只点了一次。
 *              ⚠️ 这条曾经**只有注释没有实现**（`onSubmit` 里每次 `newIdemKey()`），
 *              是 A5（2026-09-29 全量审查）抓出来的"注释与实现相反"。
 *              生命周期现在由 `utils/idempotency.js` 的 `createIntentIdempotency` 承担，
 *              页面只负责在**两个时机**调 `retire()`：建单成功、意图内容变了（换地址）。
 *
 * @see ./index.vm.js（商品行/闸门/请求体）；../../utils/idempotency.js（幂等键生命周期）；
 *      ../../utils/quote-view.js（报价区）；../../utils/address-form.js（地址摘要）
 */
import {
  BUY_NOW_MODE,
  checkoutItems,
  clearsCartAfterOrder,
  contactEmailOf,
  itemRows,
  keyAction,
  orderBody,
  recoveryFor,
  resolveAddressId,
  submitGate,
} from './index.vm.js';
import { createIntentIdempotency } from '../../utils/idempotency.js';
import { addressSummary, defaultAddressId } from '../../utils/address-form.js';
import { quoteView } from '../../utils/quote-view.js';
import { errorFields } from '../../utils/error-text.js';
import { STOCK_REFUND_NOTE } from '../order-detail/index.vm.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 支付页路径；地址页（选择模式）路径；法务页路径。跳转路径只在这一处出现。 */
const PAY_PAGE = '/pages/pay/index';
const ADDRESS_PICK_PAGE = '/pages/address/index?pick=1';
const LEGAL_PAGE = '/pages/legal/index';
/**
 * 订单列表页路径（40913「在途单太多」时把人送过去，MP3-09）。
 * @why 那条错的文案说"请先完成支付或取消后再下单"，却没给去处的后果是
 *      用户要自己 回首页 → 我的 → 我的订单 → 逐张进详情取消；大多数人做不到，直接放弃。
 */
const ORDER_PAGE = '/pages/order/index';
/** 首页（tab 页，剩余清单 4-8 空态出口）。 */
const HOME_PAGE = '/pages/home/index';

Page({
  data: {
    /** 缺货整单退款说明（剩余清单 4-10：与订单详情同一句，付款前就说清楚）。 */
    stockRefundNote: STOCK_REFUND_NOTE,
    /** 空态文案（立即购买 / 购物车两种模式说法不同）。 */
    emptyText: '购物车是空的',
    /** vm `itemRows` 的输出（**不含价格**）。 */
    rows: [],
    /** vm `quoteView` 的输出；null = 还没报价。 */
    quote: null,
    /** 当前地址摘要；null = 还没有地址。 */
    address: null,
    /** 已生效的条款版本（`GET /terms`）；空串 = 还没拿到（此时不可提交）。 */
    termsVersion: '',
    /** 条款勾选态（用户侧确认，与"拿到版本"是两件事）。 */
    termsAccepted: false,
    /** 联系邮箱（选填，AJ-180；AJ-295 改名）：输入框原值与校验错误（空串 = 无错）。 */
    email: '',
    emailError: '',
    /** 提交闸门：{ok, reason}。 */
    gate: { ok: false, reason: '' },
    /** `GET /terms` 失败（闸门据此说明原因，而不是让提交时抛开发者报错，AJ-228）。 */
    termsFailed: false,
    /** 报价失败（与"报价还没回来"分开：失败不会再有结果，AJ-228）。 */
    quoteFailed: false,
    loading: false,
    submitting: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
  },

  /** 选中的地址 id（空串 = 没选/没地址）。 */
  addressId: '',
  /** 幂等键的生命周期器（@see @limitation 二）；**不放在 data 里**（它不是渲染数据）。 */
  intentKey: null,
  /**
   * **上一次带出去的请求体**（JSON 文本；没发过为 null）。
   * 规则：同一个键 ⇔ 同一份请求体（@see index.vm.js `keyAction`，AJ-228）。
   * @why 键作废时**不必**清它：作废后 `acquire()` 必给新键，这份旧文本与下一次比出
   *      "相同"还是"不同"都只是多 / 少作废一次已经作废的键，结果一样
   *      （注回实验证实：清不清它，11 条行为用例无差别——所以不写一行测不出来的代码）。
   */
  sentBody: null,
  traceId: '',

  /** 结算模式（剩余清单 4-4）：'buynow' = 立即购买（只结 globalData.buyNow 那一件）；'' = 结购物车。 */
  mode: '',

  /** @param {{mode?: string}} [options] 详情页"立即购买"带 `?mode=buynow` 进来 */
  onLoad(options) {
    this.traceId = newTraceId();
    this.intentKey = createIntentIdempotency();
    this.mode = options?.mode === BUY_NOW_MODE ? BUY_NOW_MODE : '';
    // 扫描附记：立即购买的单件丢了（进程被回收）时，空态不能说"购物车是空的"——用户的购物车可能并不空
    this.setData({
      emptyText:
        this.mode === BUY_NOW_MODE
          ? '这件商品的购买信息已失效，请回到商品页重新点"立即购买"'
          : '购物车是空的',
    });
  },

  /** 本次结算的条目（立即购买 / 购物车，见 vm `checkoutItems`）。 */
  items() {
    return checkoutItems({
      mode: this.mode,
      buyNow: app.globalData.buyNow,
      cartItems: app.globalData.cart.items(),
    });
  },

  onShow() {
    void this.refresh();
  },

  /**
   * 重读购物车 + 并发取三条 + 重算闸门。
   * @param {{keepError?: boolean}} [opts] `keepError=true` = **保留**当前错误文案
   *        （B37 / AJ-220 的恢复路径用：重报价之后还得让用户看见"刚才为什么失败"）。
   * @why 默认清掉：从条款页返回、切后台回来都会走 `onShow → refresh`，
   *      留着上一次的错误条会让用户以为"我什么都没做，它又失败了"。
   */
  async refresh(opts) {
    const keepError = opts !== null && typeof opts === 'object' && opts.keepError === true;
    this.setData(keepError ? { loading: true } : { loading: true, error: '' });
    const items = this.items();
    this.setData({ rows: itemRows(items) });

    // ⚠️ 闸门只有 `updateGate` 一处算（AJ-228）：这里曾另算一遍，漏了"超过单笔上限"与
    //    "邮箱填错"两项——每次 onShow 到请求返回之间，已经被拦住的按钮会重新可点。
    this.updateGate();

    if (items.length === 0) {
      this.setData({ loading: false, quote: null });
      return;
    }
    await Promise.all([this.fetchTerms(), this.fetchAddresses(), this.fetchQuote(items)]);
    this.setData({ loading: false });
  },

  /** `GET /terms`：条款版本是**建单必填**（D-43，不一致即 40011）。 */
  async fetchTerms() {
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/terms`,
        traceId: this.traceId,
      });
      const version = typeof res?.version === 'string' ? res.version : '';
      this.setData({ termsVersion: version, termsFailed: version === '' });
    } catch (e) {
      // ⚠️ 拿不到版本 = 不能下单：由闸门拦住并说明（termsFailed），不留给提交时再失败
      this.setData({ termsVersion: '', termsFailed: true, ...errorFields(e) });
    }
    this.updateGate();
  },

  /** `GET /addresses`：预选默认地址，或消费地址页回传的一次性选择。 */
  async fetchAddresses() {
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/addresses`,
        traceId: this.traceId,
      });
      const list = Array.isArray(res) ? res : [];
      // ⚠️ 一次性交接：读走立刻清空（留着会让下次进结算页拿到过期选择）
      const picked = app.globalData.pickedAddressId;
      app.globalData.pickedAddressId = '';
      // ⚠️ 三段优先级（A6）：一次性选择 > **当前已选** > 默认。
      //    少了中间那段，每次 onShow 都会把用户选好的地址换回默认——
      //    看条款返回、切后台回来都会中招，而页面显示的确实是默认地址，用户不会再核对。
      const id = resolveAddressId({
        picked,
        current: this.addressId,
        list,
        fallback: defaultAddressId(list),
      });
      const found = list.find((a) => a && a.id === id);
      // 地址换了 = 订单意图变了 → 旧键必须作废：否则新地址下的建单会被服务端
      // 按同一个键重放成**旧地址**那张单（@see utils/idempotency.js 的 retire 说明）
      if (picked !== '' && picked !== undefined && picked !== this.addressId) {
        this.intentKey?.retire();
      }
      this.addressId = id;
      this.setData({ address: found === undefined ? null : addressSummary(found) });
    } catch (e) {
      this.setData({ ...errorFields(e) });
    }
    this.updateGate();
  },

  /** `POST /orders/quote`：合计的**唯一**来源。 */
  async fetchQuote(items) {
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/quote`,
        method: 'POST',
        data: { items: items.map((i) => ({ product_id: i.productId, qty: i.qty })) },
        traceId: this.traceId,
      });
      this.setData({ quote: quoteView(res), quoteFailed: false });
    } catch (e) {
      this.setData({ quote: null, quoteFailed: true, ...errorFields(e) });
    }
    this.updateGate();
  },

  /** 重算提交闸门（三条取数各自完成后都要调一次）。 */
  updateGate() {
    const gate = submitGate({
      itemCount: this.data.rows.length,
      addressId: this.addressId,
      termsAccepted: this.data.termsAccepted,
      totalJpy: this.data.quote?.totalJpy ?? null,
      emailError: this.data.emailError,
      // B38 / AJ-221：超过单笔上限时**不放行**（提交必然 40906）
      splitRequired: this.data.quote?.splitRequired === true,
      termsReady: this.data.termsVersion !== '',
      termsFailed: this.data.termsFailed === true,
      quoteFailed: this.data.quoteFailed === true,
    });
    this.setData({ gate });
  },

  /** 邮箱输入（选填）：每次输入都重算错误与闸门，错误就近显示在输入框下。 */
  onEmailInput(e) {
    const raw = typeof e?.detail?.value === 'string' ? e.detail.value : '';
    this.setData({ email: raw, emailError: contactEmailOf(raw).error });
    this.updateGate();
  },

  onToggleTerms() {
    this.setData({ termsAccepted: !this.data.termsAccepted });
    this.updateGate();
  },

  /**
   * 换地址：跳地址页的选择模式（回传走一次性交接，@see 文件头）。
   *
   * ⚠️ 建单在途时**不跳**（MP3-10）：此时跳走，建单成功后 `navigateTo` 支付页会压在
   *    地址选择页上面，栈变成 [购物车, 结算, 地址, 支付]。用户从支付页返回，
   *    落在一张"为已下完的单选地址"的页面上；点"用这个地址"后回到的是空购物车的结算页。
   * @why 这不是 AJ-74 禁止的"按钮连点守卫"：那一条挡的是"同一个动作发两次请求"，
   *      这里挡的是**离开这一页**——页面栈的状态会被建单的返回路径改坏。
   * @limitation 只是不跳，不给提示：转圈中的提交按钮已经说明了"正在处理"。
   */
  onPickAddress() {
    if (this.data.submitting === true) return;
    wxApi.navigateTo({ url: ADDRESS_PICK_PAGE });
  },

  /**
   * 查看条款全文。
   * @why 勾选框的**另一半**：没有去处，"已阅读"这三个字是空的
   *      （@see ./index.wxml 条款区的注释；pages/legal/index.js 文件头）。
   * @why 用 `navigateTo` 而不是 `redirectTo`：看完条款要**回到**结算页继续下单，
   *      且保留页面栈意味着 `termsAccepted` / `quote` / `addressId` 都还在
   *      （redirectTo 会把结算页关掉，用户得从购物车重走一遍）。
   */
  onOpenTerms() {
    // @see onPickAddress：建单在途时不离开这一页（MP3-10）
    if (this.data.submitting === true) return;
    wxApi.navigateTo({ url: LEGAL_PAGE });
  },

  /**
   * 提交建单。
   * @why 键在这里**取**而不是**造**：`acquire()` 首次给新键、之后给同一个键，
   *      于是"上一次失败、用户再点一次"走的是同一个键，服务端认出是重放、
   *      不会建出第二张单（A5）。失败路径刻意**不** `retire()`——键要留给重试。
   */
  onSubmit() {
    // 建单在途时直接忽略（W-03）：页面的 data 在 setData 后同步更新，而按钮组件的 loading 属性
    // 要等视图层回传——只靠按钮挡，快速双击的第二下会穿透，压入两个支付页。
    if (this.data.submitting === true) return;
    if (!this.data.gate.ok || this.intentKey === null) return;
    let body;
    try {
      body = orderBody({
        items: this.items(),
        addressId: this.addressId,
        termsVersion: this.data.termsVersion,
        expectedTotalJpy: this.data.quote?.totalJpy ?? null,
        contactEmail: contactEmailOf(this.data.email).value,
      });
    } catch {
      // 闸门已经拦住了会让 orderBody 抛的两种情形（没地址 / 没条款版本）；走到这里说明
      // 闸门与 orderBody 的前提不同步了。不把那句给开发者看的报错摆出来，重算闸门让它自己说。
      this.updateGate();
      return;
    }
    // 同一个键 ⇔ 同一份请求体：内容变了就换键（AJ-228，@see index.vm.js `keyAction`）
    const json = JSON.stringify(body);
    if (keyAction({ sentBody: this.sentBody, body: json }) === 'renew') this.intentKey?.retire();
    const { key } = this.intentKey.acquire();
    this.sentBody = json;
    void this.createOrder(key, body);
  },

  /**
   * @param {string} idemKey
   * @param {object} body `onSubmit` 组好的请求体（与取键时比对的是同一份）
   */
  async createOrder(idemKey, body) {
    this.setData({ submitting: true, error: '' });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders`,
        method: 'POST',
        data: body,
        idempotencyKey: idemKey,
        traceId: this.traceId,
      });
      // @see @limitation 一：建单成功即清车（订单已存在，支付失败可去订单页继续）
      // 立即购买不清车（剩余清单 4-4，vm `clearsCartAfterOrder`）；单件条目用完即弃
      if (clearsCartAfterOrder(this.mode)) app.globalData.cart.clear();
      else app.globalData.buyNow = null;
      // 意图已完成：作废键。再点一次是**新的一张单**，沿用旧键会被重放成刚才那张
      this.intentKey?.retire();
      // 剩余清单 4-8：redirectTo 而不是 navigateTo——车已清空，留在返回栈里的结算页只剩"购物车是空的"；
      //    支付页按返回键应回到下单前的页面（购物车 / 商品详情），不是一张空结算页
      wxApi.redirectTo({ url: `${PAY_PAGE}?orderId=${res?.order_id ?? ''}` });
    } catch (e) {
      const code = e !== null && typeof e === 'object' && Number.isInteger(e.code) ? e.code : 0;
      // ⚠️ 默认**不** retire：键留给重试（弱网下用户看到错误再点一次必须还是同一个键）
      this.setData({ ...errorFields(e) });
      // B37 / AJ-220：执行错误码登记表里写明的恢复动作——
      // 不执行的话 40905（管理员改价）会变成"再点还是 40905，只能退出重进"。
      if (recoveryFor(code) === 'requote') {
        // 价格/库存/商品变了 = 意图内容变了 → 旧键不能沿用（同键提交不同内容会被拒）
        this.intentKey?.retire();
        // ⚠️ 报价**必须先作废再重取**（MP3-05）：`refresh` 一开头就调 `updateGate`，
        //    此刻 `quote` 还是旧值 ⇒ 闸门以旧合计放行 ⇒ 用户再点一次必然再吃一次 40905
        //    （请求体里的 expected_total_jpy 还是旧的）。弱网下可以循环好几轮。
        //    置空之后闸门落到"运费与合计还在计算中"，把这一轮挡住，等新报价回来再放行。
        this.setData({ quote: null, quoteFailed: false });
        // keepError：重报价之后仍要让用户看见"刚才为什么失败"（否则他不知道要重新确认金额）
        void this.refresh({ keepError: true });
      } else if (recoveryFor(code) === 'go_orders') {
        // 40913：在途单已达上限——文案说了"请先完成支付或取消"，就得给一个能去的地方。
        // ⚠️ S5 之后订单是 tab 页，**只能** `switchTab`（navigateTo 会被宿主拒绝）。
        // @tradeoff 原先的 navigateTo 是为了"用户付掉/取消一张单后**还能回到这一页**"；
        //      switchTab 会关掉本页，那一层便利没有了。仍然这么改的理由：
        //      ① 购物车在**本地 storage**（cart-store），不会被切 tab 清掉，
        //         用户从「购物车」tab 重新进结算即可，商品没丢；
        //      ② 收银台上唯一会丢的是"已勾选条款 / 选中的地址"，重选一次的成本
        //         远小于"点了去订单却没反应"（宿主拒绝 navigateTo 时的表现）。
        //      ⚠️ 若将来要把"回到结算页"找回来，正确做法是让订单页在结案后
        //         `redirectTo` 结算页，而不是把订单从 tabBar 里挪出去。
        wxApi.switchTab({ url: ORDER_PAGE });
      } else if (recoveryFor(code) === 'reload_terms') {
        // 条款升级：重拉版本并把"已同意"复位（让用户对新条款重新确认，而不是对着旧版本点头）
        this.setData({ termsAccepted: false });
        void this.fetchTerms();
      } else if (recoveryFor(code) === 'renew_key') {
        // 40908：同键不同内容。作废键，下一次点击就是一次新的意图（AJ-228）
        this.intentKey?.retire();
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 空态"去逛逛"（剩余清单 4-8）：首页是 tab 页，只能 switchTab。 */
  onGoShopping() {
    wxApi.switchTab({ url: HOME_PAGE });
  },
});
