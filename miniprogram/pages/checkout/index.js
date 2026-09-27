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
 * @limitation 二：幂等键**一次提交一个**（`this.idemKey`），重试复用同一个——
 *              每次重试都换键的话，网络一抖就建出两张单，而用户只点了一次。
 *
 * @see ./index.vm.js（商品行/闸门/幂等键/请求体，12 条单测）；
 *      ../../utils/quote-view.js（报价区）；../../utils/address-form.js（地址摘要）
 */
import { itemRows, orderBody, submitGate } from './index.vm.js';
import { newIdemKey } from '../../utils/idem-key.js';
import { addressSummary, defaultAddressId } from '../../utils/address-form.js';
import { quoteView } from '../../utils/quote-view.js';
import { errorMessage } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 支付页路径；地址页（选择模式）路径。跳转路径只在这一处出现。 */
const PAY_PAGE = '/pages/pay/index';
const ADDRESS_PICK_PAGE = '/pages/address/index?pick=1';

Page({
  data: {
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
    /** 提交闸门：{ok, reason}。 */
    gate: { ok: false, reason: '' },
    loading: false,
    submitting: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
  },

  /** 选中的地址 id（空串 = 没选/没地址）。 */
  addressId: '',
  /** 本次提交的幂等键（@see @limitation 二）。 */
  idemKey: '',
  traceId: '',

  onLoad() {
    this.traceId = newTraceId();
  },

  onShow() {
    void this.refresh();
  },

  /** 重读购物车 + 并发取三条 + 重算闸门。 */
  async refresh() {
    this.setData({ loading: true });
    const items = app.globalData.cart.items();
    this.setData({ rows: itemRows(items) });

    // ⚠️ 空车不报价也不建单：空 items 会被服务端 40001 拒，
    //    而"打开空的结算页有个错误提示"是荒谬的
    const gate = submitGate({
      itemCount: items.length,
      addressId: this.addressId,
      termsAccepted: this.data.termsAccepted,
      totalJpy: this.data.quote?.totalJpy ?? null,
    });
    this.setData({ gate });

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
      this.setData({ termsVersion: typeof res?.version === 'string' ? res.version : '' });
    } catch (e) {
      // ⚠️ 拿不到版本 = 不能下单（vm 的 orderBody 会抛）：明示而不是留空串让用户提交失败
      this.setData({ error: errorMessage(e) });
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
      const id =
        picked !== '' && list.some((a) => a && a.id === picked) ? picked : defaultAddressId(list);
      const found = list.find((a) => a && a.id === id);
      this.addressId = id;
      this.setData({ address: found === undefined ? null : addressSummary(found) });
    } catch (e) {
      this.setData({ error: errorMessage(e) });
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
      this.setData({ quote: quoteView(res) });
    } catch (e) {
      this.setData({ quote: null, error: errorMessage(e) });
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
    });
    this.setData({ gate });
  },

  onToggleTerms() {
    this.setData({ termsAccepted: !this.data.termsAccepted });
    this.updateGate();
  },

  /** 换地址：跳地址页的选择模式（回传走一次性交接，@see 文件头）。 */
  onPickAddress() {
    wxApi.navigateTo({ url: ADDRESS_PICK_PAGE });
  },

  /** 提交建单。 */
  onSubmit() {
    if (!this.data.gate.ok) return;
    // ⚠️ 一次提交一个幂等键（重试复用，@see @limitation 二）
    this.idemKey = newIdemKey();
    void this.createOrder();
  },

  async createOrder() {
    this.setData({ submitting: true, error: '' });
    try {
      const body = orderBody({
        items: app.globalData.cart.items(),
        addressId: this.addressId,
        termsVersion: this.data.termsVersion,
        expectedTotalJpy: this.data.quote?.totalJpy ?? null,
      });
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders`,
        method: 'POST',
        data: body,
        idempotencyKey: this.idemKey,
        traceId: this.traceId,
      });
      // @see @limitation 一：建单成功即清车（订单已存在，支付失败可去订单页继续）
      app.globalData.cart.clear();
      wxApi.navigateTo({ url: `${PAY_PAGE}?orderId=${res?.order_id ?? ''}` });
    } catch (e) {
      this.setData({ error: errorMessage(e) });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
