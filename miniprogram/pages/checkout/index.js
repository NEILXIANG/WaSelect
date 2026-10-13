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
  checkoutEmptyAction,
  checkoutEmptyText,
  checkoutItems,
  clearsCartAfterOrder,
  contactEmailOf,
  EMAIL_REQUIRED_TEXT,
  emailInputError,
  goneExit,
  itemRows,
  rowsWithQuotePrice,
  keyAction,
  namedItemError,
  orderBody,
  recoveryFor,
  resolveAddressId,
  submitGate,
  addressFailedText,
  termsFromResponse,
} from './index.vm.js';
import { createIntentIdempotency } from '../../utils/idempotency.js';
import { addressSummary, defaultAddressId } from '../../utils/address-form.js';
import { quoteView } from '../../utils/quote-view.js';
import {
  CHARGE_CURRENCY_ORDER,
  channelCountryOf,
  chargeOptions,
  chargePreview,
} from '../../utils/pay-plan.js';
import { isStale, nextSeq } from '../../utils/request-seq.js';
import { contactFields, errorFields, isAccountBlocked } from '../../utils/error-text.js';
import { emailTypoHint, normalizeTypedEmail } from '../../utils/email-shape.js';
import { STOCK_REFUND_NOTE } from '../../utils/order-status.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import { track } from '../../utils/beacon.js';

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
/** 购物车（tab 页）：商品已下架时回这里删掉它（联动走查 2026-10-10）；车里有货没勾时空态也回这里。 */
const CART_PAGE = '/pages/cart/index';
/** 「我的」（tab 页）：客服联系方式在那里（F4：账号受限时错误态去这里）。 */
const USER_PAGE = '/pages/user/index';
/**
 * 上次下单用的联系邮箱（A5，AJ-416）：再次结算时自动填上。
 * @why 邮箱是必填（M-01），每单重输一遍是纯摩擦；只在**下单成功后**记——填错被拦下的不记。
 * @limitation 存在本机（`ws:` 前缀，utils/storage.js），换手机 / 清缓存后要重填；
 *             不去服务端取"上一单的邮箱"——那要多一个接口，而本机记住已覆盖绝大多数回头客。
 */
const EMAIL_KEY = 'checkout_email';

Page({
  data: {
    /** 缺货整单退款说明（剩余清单 4-10：与订单详情同一句，付款前就说清楚）。 */
    stockRefundNote: STOCK_REFUND_NOTE,
    /** 空态文案（立即购买 / 购物车两种模式说法不同）。 */
    emptyText: '购物车是空的',
    /** 空态按钮去向（'cart' = 回购物车勾选；'home' = 去首页逛）。 */
    emptyAction: 'home',
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
    /** 联系邮箱（AJ-180；AJ-295 改名；M-01 起前端必填）：输入框原值与校验错误（空串 = 无错或还没动过输入框）。 */
    email: '',
    emailError: '',
    /** 常见拼错提示（MP-9，不拦；空串 = 不显示）。 */
    emailHint: '',
    /** 提交闸门：{ok, reason}。 */
    gate: { ok: false, reason: '' },
    /** `GET /terms` 失败（闸门据此说明原因，而不是让提交时抛开发者报错，AJ-228）。 */
    termsFailed: false,
    /** 报价失败（与"报价还没回来"分开：失败不会再有结果，AJ-228）。 */
    quoteFailed: false,
    /** 报价失败的错误码（F4：停售按码说原因）。 */
    quoteErrorCode: 0,
    /**
     * 这次报价失败是不是"账号被拉黑"（规律排查 2026-10-12；闸门据此说"账号受限"）。
     * @why 与 `quoteErrorCode` 分开存：码有多个成因（40301 里有源站校验失败），
     *      "是不是该找客服"这个结论只由 `utils/error-text.js` 的 `isAccountBlocked` 下。
     */
    quoteBlocked: false,
    /** `GET /addresses` 失败（F5：闸门说"没取到"，地址卡不说"还没有地址"）。 */
    addressFailed: false,
    /** 地址没取到时地址卡上的那句话（vm `addressFailedText`；账号受限另有说法）。 */
    addressFailedText: '',
    /** 错误态按钮去客服而不是重新加载（F4：40301 账号受限，重新加载永远不会好）。 */
    errorContact: false,
    /** 报价 / 建单回 40401（商品已下架）：错误态按钮换成去首页 / 购物车。 */
    productGone: false,
    goneActionText: '',
    /**
     * M-16（AJ-406）：扣款币种预告（utils/pay-plan.js `chargePreview`）；空数组 = 不显示。
     * @why 円是主显示（D-32 / D-69，AJ-402 Q3），银行卡却以美元扣——此前实扣美元金额要到支付页才看到。
     */
    chargePreview: [],
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
  /** 最近一次报价的原始响应（M-16：`chargeOptions` 读它的 total_jpy / display）；null = 没有可用报价。 */
  quoteRaw: null,
  /**
   * `GET /addresses` 那次失败是不是"账号被拉黑"（规律排查 2026-10-12）。
   * @why 不放在 data 里：它不是渲染数据——地址卡那句话已经在 data 的 `addressFailedText` 上
   *      （由 vm 用它算出来），闸门在 `updateGate` 里读它。**不存错误码**：40301 有多种成因，
   *      存码就要在每个读它的人那里再判一次，那正是这条规律要收掉的东西。
   */
  addressBlocked: false,
  /** 当前地址的国家（M-16：查通道用，utils/pay-plan.js `channelCountryOf`）。 */
  addressCountry: '',
  /** 扣款预告的请求序号（只接受最新一次；refresh 可能并发）。 */
  previewSeq: 0,
  /** 报价请求序号（审查 2026-10-09：两次并发报价，旧的后到不许盖新的）。 */
  quoteSeq: 0,

  /** 结算模式（剩余清单 4-4）：'buynow' = 立即购买（只结 globalData.buyNow 那一件）；'' = 结购物车。 */
  mode: '',

  /**
   * 页面是否还活着（P2-36）：onUnload 置 false。
   * @why 建单在途时用户按了返回，响应回来仍会 `redirectTo` 支付页——用户已经离开结算，
   *      却被拽进一张支付页（还替换掉了他返回到的那一页）。销毁后只做"必须做的"（清车），不再导航。
   * @limitation 幂等键是**每个页面实例一份**（onLoad 里 createIntentIdempotency）：用户返回后再进结算页
   *      会拿到新键——上一次若其实已建成，就会多出一张待付款单（30 分钟后自动关单回补库存）。
   *      这是刻意保留的设计：键跨页面实例共享，就得回答"什么时候算同一个意图"，而购物车随时可改。
   */
  alive: true,

  /** @param {{mode?: string}} [options] 详情页"立即购买"带 `?mode=buynow` 进来 */
  onLoad(options) {
    track(app, 'checkout_enter'); // M-21：进结算（每个页面实例一次；onShow 的回访不重复记）
    this.alive = true;
    this.traceId = newTraceId();
    this.intentKey = createIntentIdempotency();
    this.mode = options?.mode === BUY_NOW_MODE ? BUY_NOW_MODE : '';
    const remembered = app.globalData.storage?.getString(EMAIL_KEY) ?? '';
    if (remembered !== '' && this.data.email === '') this.setData({ email: remembered });
    // 空态文案与按钮去向由 vm 一处收口（checkoutEmptyText / checkoutEmptyAction 同参数同分支）：
    // "结算页没东西可结"有三种成因（车空 / 车里有货没勾 / 立即购买的单件丢了），各自的下一步不同；
    // 文案与按钮必须说同一件事（文案指购物车、按钮就不能去首页）。
    const emptyArgs = { mode: this.mode, cartCount: app.globalData.cart.items().length };
    this.setData({
      emptyText: checkoutEmptyText(emptyArgs),
      emptyAction: checkoutEmptyAction(emptyArgs),
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
    track(app, 'page_view', { page: 'checkout' }); // M-21 页面曝光
    void this.refresh();
  },

  onUnload() {
    // P2-36：在途的建单回来后不再跳转（@see alive）
    this.alive = false;
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
    this.setData(
      keepError
        ? { loading: true }
        : { loading: true, error: '', errorContact: false, quoteBlocked: false },
    );
    // 与上面同一个道理：默认清掉"上次是账号被拉黑"这个结论，由这两条取数各自重新下
    //   （@see fetchAddresses / fetchQuote；keepError 路径也会重取，所以不必分情况）
    this.addressBlocked = false;
    const items = this.items();
    this.setData({ rows: itemRows(items) });

    // ⚠️ 闸门只有 `updateGate` 一处算（AJ-228）：这里曾另算一遍，漏了"超过单笔上限"与
    //    "邮箱填错"两项——每次 onShow 到请求返回之间，已经被拦住的按钮会重新可点。
    this.updateGate();

    if (items.length === 0) {
      this.quoteRaw = null;
      this.setData({ loading: false, quote: null, chargePreview: [] });
      return;
    }
    await Promise.all([this.fetchTerms(), this.fetchAddresses(), this.fetchQuote(items)]);
    this.setData({ loading: false });
    // M-16：要等报价（金额）与地址（国家）都到了才能查通道，所以排在三条并发之后
    await this.fetchChargePreview();
  },

  /**
   * 扣款币种预告（M-16，AJ-406）：按报价合计与地址国家查 `GET /pay/channels`（与支付页同一组查询）。
   * @why 失败**静默**（清空预告）：它是辅助说明，不是下单前提；支付页的 §14.2 提示条仍会说清实扣金额。
   *      为它在结算页顶一个错误条，会把"能下单"的页面显示成"有一步没完成"。
   * @limitation 多出 `CHARGE_CURRENCY_ORDER.length` 个请求（当前 2 个）；只在 refresh 时查，不随输入邮箱等重查。
   */
  async fetchChargePreview() {
    const seq = (this.previewSeq = nextSeq(this.previewSeq));
    const total = this.quoteRaw?.total_jpy;
    if (!Number.isInteger(total) || this.addressId === '') {
      this.setData({ chargePreview: [] });
      return;
    }
    const quote = this.quoteRaw;
    try {
      const listings = [];
      for (const currency of CHARGE_CURRENCY_ORDER) {
        const resp = await app.globalData.api({
          url: `${app.globalData.apiBase}/api/v1/pay/channels?country=${this.addressCountry}&currency=${currency}&amount_jpy=${total}`,
          traceId: this.traceId,
        });
        listings.push({ currency, resp });
      }
      if (isStale(seq, this.previewSeq)) return;
      this.setData({ chargePreview: chargePreview(chargeOptions(listings, quote)) });
    } catch {
      if (isStale(seq, this.previewSeq)) return;
      this.setData({ chargePreview: [] });
    }
  },

  /** `GET /terms`：条款版本是**建单必填**（D-43，不一致即 40011）。 */
  async fetchTerms() {
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/terms`,
        traceId: this.traceId,
      });
      // 版本 + 条款地址都要有才算就绪（AJ-441）：没有地址时放行"已阅读并同意"等于同意一份打不开的条款
      this.setData(termsFromResponse(res));
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
      this.addressCountry = channelCountryOf(found);
      this.setData({
        address: found === undefined ? null : addressSummary(found),
        addressFailed: false,
      });
    } catch (e) {
      // F5：取失败 ≠ 没有地址——闸门与地址卡据此说"没取到"，而不是"请选择 / 点这里新增"
      // 账号**被拉黑**时地址卡与闸门说"账号受限"，不叫人去点"重新加载"（两端逐页走查第三轮）。
      // ⚠️ 判据只有一处：error-text.js 的 isAccountBlocked（规律排查 2026-10-12——
      //    40301 还有"源站校验失败"这种买家同样碰得到的成因，照码判会把它说成用户自己的问题）。
      this.addressBlocked = isAccountBlocked(e);
      this.setData({
        addressFailed: true,
        addressFailedText: addressFailedText(this.addressBlocked),
        ...errorFields(e),
        ...contactFields(e),
      });
    }
    this.updateGate();
  },

  /** `POST /orders/quote`：合计的**唯一**来源。 */
  async fetchQuote(items) {
    // 领号（审查 2026-10-09）：40905 恢复路径的 refresh 与切回前台的 refresh 会并发两次报价，
    //   改价前发出的那次若后到，会把新合计盖回旧值——再提交又吃一次 40905（扣款预告早已这么做）
    const seq = (this.quoteSeq = nextSeq(this.quoteSeq));
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/quote`,
        method: 'POST',
        data: { items: items.map((i) => ({ product_id: i.productId, qty: i.qty })) },
        traceId: this.traceId,
      });
      if (isStale(seq, this.quoteSeq)) return;
      this.quoteRaw = res !== null && typeof res === 'object' ? res : null;
      this.setData({
        rows: rowsWithQuotePrice(this.data.rows, this.quoteRaw),
        quote: quoteView(res),
        quoteFailed: false,
        quoteErrorCode: 0,
        quoteBlocked: false,
        productGone: false,
      });
    } catch (e) {
      if (isStale(seq, this.quoteSeq)) return;
      const named = namedItemError(e, items, { buyNow: this.mode === BUY_NOW_MODE }); // U9：点名是哪一件
      this.quoteRaw = null;
      this.setData({
        rows: rowsWithQuotePrice(this.data.rows, null),
        quote: null,
        quoteFailed: true,
        // F4：闸门按码说原因（停售不说"返回购物车重试"）
        quoteErrorCode: Number.isInteger(e?.code) ? e.code : 0,
        // 规律排查 2026-10-12：40301 里只有"被拉黑"才是"找客服"，源站校验失败仍该重试——
        //   这个结论由 error-text.js 一处下（本文件、vm 都不再判 40301）
        quoteBlocked: isAccountBlocked(e),
        // 40401 = 商品已下架或不存在：重试不会好，错误态按钮换成去首页 / 购物车（联动走查 2026-10-10）
        productGone: e?.code === 40401,
        goneActionText: goneExit(this.mode === BUY_NOW_MODE).actionText,
        ...errorFields(e),
        ...contactFields(e),
        ...(named !== '' ? { error: named } : {}),
      });
    }
    this.updateGate();
  },

  /** 重算提交闸门（三条取数各自完成后都要调一次）。 */
  updateGate() {
    const gate = submitGate({
      buyNow: this.mode === BUY_NOW_MODE,
      itemCount: this.data.rows.length,
      addressId: this.addressId,
      termsAccepted: this.data.termsAccepted,
      totalJpy: this.data.quote?.totalJpy ?? null,
      emailError: this.data.emailError,
      // M-01（AJ-405）：邮箱前端必填——没填时闸门说明用途；输入框下的 emailError 只在用户动过输入框后出现
      contactEmail: contactEmailOf(this.data.email).value,
      // B38 / AJ-221：超过单笔上限时**不放行**（提交必然 40906）
      splitRequired: this.data.quote?.splitRequired === true,
      termsReady: this.data.termsVersion !== '',
      termsFailed: this.data.termsFailed === true,
      quoteFailed: this.data.quoteFailed === true,
      quoteErrorCode: this.data.quoteErrorCode,
      quoteBlocked: this.data.quoteBlocked === true,
      addressFailed: this.data.addressFailed === true,
      addressBlocked: this.addressBlocked === true,
      productGone: this.data.productGone === true,
    });
    this.setData({ gate });
  },

  /**
   * 邮箱输入（M-01 起必填）：重算闸门；错误只在**已经报过**时实时重判（F7，vm `emailInputError`）——
   * 没写完就红一句"格式不正确"是在打断人。拼错提示（MP-9）随输入更新、不拦。
   */
  onEmailInput(e) {
    const raw = typeof e?.detail?.value === 'string' ? e.detail.value : '';
    this.setData({
      email: raw,
      emailError: emailInputError(raw, this.data.emailError),
      emailHint: emailTypoHint(normalizeTypedEmail(raw)),
    });
    this.updateGate();
  },

  /**
   * 邮箱失焦（F7）：这时才判格式并就近显示。
   * 空着的不在这里新报（只是点进来又离开，闸门那一行已说明为什么要填）；清空时 onEmailInput 已经报过的保留。
   */
  onEmailBlur() {
    const raw = typeof this.data.email === 'string' ? this.data.email : '';
    this.setData({
      emailError: raw.trim() === '' ? this.data.emailError : contactEmailOf(raw).error,
      emailHint: emailTypoHint(normalizeTypedEmail(raw)),
    });
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
   * 点「提交订单」时缺的是买家能补的一项：带过去（全入口点击测试 2026-10-11，vm `submitGate` 的 `fix`）。
   * @why 主流确认页的做法：按钮常亮，缺地址就进选地址，没同意条款就弹窗请同意，没填邮箱就滚到邮箱框。
   *      原先按钮浅灰、条款勾选框在两屏之下，新手不知道该点哪。
   * @why 条款走弹窗而不是替人勾上：同意必须是买家自己点的「同意」（弹窗里另有「查看条款」进全文）；
   *      点了「同意」才勾选并继续提交——这一下就是买家的同意动作，建单照旧带条款版本。
   * @limitation fix 为空（补不了的原因）时什么都不做：按钮本就置灰，原因写在底部栏。
   * @param {string} fix
   */
  goFix(fix) {
    if (fix === 'address') {
      this.onPickAddress();
      return;
    }
    if (fix === 'terms') {
      wxApi.showModal({
        title: '请阅读并同意购买条款',
        content: `提交订单前需要同意《购买条款》（版本 ${this.data.termsVersion}）。想先看全文可点「查看条款」。`,
        confirmText: '同意',
        cancelText: '查看条款',
        success: (r) => {
          if (r.confirm) {
            this.setData({ termsAccepted: true });
            this.updateGate();
            this.onSubmit();
          } else if (r.cancel) {
            this.onOpenTerms();
          }
        },
      });
      return;
    }
    if (fix === 'email') {
      const shown = typeof this.data.emailError === 'string' ? this.data.emailError : '';
      this.setData({ emailError: shown !== '' ? shown : EMAIL_REQUIRED_TEXT });
      this.updateGate();
      wxApi.pageScrollTo({ selector: '#contact-email', duration: 200 });
    }
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
    if (!this.data.gate.ok) {
      this.goFix(this.data.gate.fix);
      return;
    }
    if (this.intentKey === null) return;
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
    this.setData({ submitting: true, error: '', errorContact: false });
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
      // A3（AJ-416）：只移除这次买走的那几件（没勾的留在车里），不是整车清空
      if (clearsCartAfterOrder(this.mode)) {
        app.globalData.cart.removeMany(body.items.map((i) => i.product_id));
      } else app.globalData.buyNow = null;
      if (typeof body.contact_email === 'string' && body.contact_email !== '') {
        app.globalData.storage?.setString(EMAIL_KEY, body.contact_email);
      }
      // 意图已完成：作废键。再点一次是**新的一张单**，沿用旧键会被重放成刚才那张
      this.intentKey?.retire();
      // P2-36：用户已经离开这一页（按了返回）→ 不再把他拽进支付页；订单可在「我的订单」里继续付
      if (!this.alive) return;
      // 剩余清单 4-8：redirectTo 而不是 navigateTo——车已清空，留在返回栈里的结算页只剩"购物车是空的"；
      //    支付页按返回键应回到下单前的页面（购物车 / 商品详情），不是一张空结算页
      wxApi.redirectTo({ url: `${PAY_PAGE}?orderId=${res?.order_id ?? ''}` });
    } catch (e) {
      const code = e !== null && typeof e === 'object' && Number.isInteger(e.code) ? e.code : 0;
      // ⚠️ 默认**不** retire：键留给重试（弱网下用户看到错误再点一次必须还是同一个键）
      const named = namedItemError(e, this.items(), { buyNow: this.mode === BUY_NOW_MODE }); // U9：点名是哪一件
      this.setData({
        ...errorFields(e),
        ...contactFields(e),
        ...(named !== '' ? { error: named } : {}),
      });
      // B37 / AJ-220：执行错误码登记表里写明的恢复动作——
      // 不执行的话 40905（管理员改价）会变成"再点还是 40905，只能退出重进"。
      if (recoveryFor(code) === 'requote') {
        // 价格/库存/商品变了 = 意图内容变了 → 旧键不能沿用（同键提交不同内容会被拒）
        this.intentKey?.retire();
        // ⚠️ 报价**必须先作废再重取**（MP3-05）：`refresh` 一开头就调 `updateGate`，
        //    此刻 `quote` 还是旧值 ⇒ 闸门以旧合计放行 ⇒ 用户再点一次必然再吃一次 40905
        //    （请求体里的 expected_total_jpy 还是旧的）。弱网下可以循环好几轮。
        //    置空之后闸门落到"运费与合计还在计算中"，把这一轮挡住，等新报价回来再放行。
        this.quoteRaw = null;
        this.setData({ quote: null, quoteFailed: false, chargePreview: [] });
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
        // 统一结论 5.3：先弹窗把原因说清，用户点「去处理」才走——原先写完文案立刻 switchTab，
        //   结算页一关文案就没了，用户只看到被甩到订单页。选「留在本页」时页面内文案仍在。
        wxApi.showModal({
          title: '先处理未付款的订单',
          content: String(this.data.error || '未付款的订单太多了，请先完成支付或取消后再下单'),
          confirmText: '去处理',
          cancelText: '留在本页',
          success: (r) => {
            if (r?.confirm === true) wxApi.switchTab({ url: ORDER_PAGE });
          },
        });
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

  /**
   * 错误态的"重新加载"（P2-38）：重取条款 / 地址 / 报价。
   * @why 不重发建单：建单只由「提交订单」触发（幂等键在那条路上），这里只刷新页面数据。
   *      建单在途时不动——refresh 会改写闸门与报价，和在途的建单结果互相覆盖。
   */
  onRetry() {
    if (this.data.submitting === true) return;
    // F4：账号受限（40301）——重新加载永远不会好，去「我的」找客服
    if (this.data.errorContact === true) {
      wxApi.switchTab({ url: USER_PAGE });
      return;
    }
    // 商品已下架：重报价不会好——立即购买回首页，购物车结算回购物车删掉它（联动走查 2026-10-10）
    if (this.data.productGone === true) {
      if (goneExit(this.mode === BUY_NOW_MODE).target === 'home')
        wxApi.switchTab({ url: HOME_PAGE });
      else wxApi.switchTab({ url: CART_PAGE });
      return;
    }
    void this.refresh();
  },

  /** 空态按钮（剩余清单 4-8 + 2026-10-12：车里有货没勾 → 回购物车，其余 → 去首页）。 */
  onGoShopping() {
    // ⚠️ 写成 if/else 而不是三元：tab-nav-guard 只认「目标页是常量」的跳转（AJ-366），
    //    三元里解析不出目标会被记成"未知跳转"（守卫要求每文件最多 1 条，加白名单=削弱守卫）。
    if (this.data.emptyAction === 'cart') wxApi.switchTab({ url: CART_PAGE });
    else wxApi.switchTab({ url: HOME_PAGE });
  },
});
