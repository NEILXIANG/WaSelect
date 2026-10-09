/**
 * 职责：售后申请页薄壳（AJ-420）——选原因、写描述 → POST /orders/{id}/after-sales → 出栈回订单详情。
 *
 * @why 成功后**出栈**而不是跳转：订单详情 onShow 会重取，回去就看到"已提交，等待处理"——
 *      不另做成功页，也不弹 toast（showToast 未登记，@see utils/wx-api @limitation 九）。
 * @why 提交在途时忽略再点：服务端虽有部分唯一索引兜底（第二次 40902），但让买家看到"已有进行中的申请"
 *      而他只点了一次，会以为出错了。
 * @limitation 链接里没有订单 id 时整页显示错误、不给表单（空 id 会撞到别的路由）。
 * @see ./index.vm.js；server/src/app/after-sale-routes.ts
 */
import { REASON_LABELS, conflictText, formView, initialForm, submitBody } from './index.vm.js';
import { AFTER_SALE_DESCRIPTION_MAX } from '../../utils/after-sale.js';
import { errorFields } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();
const wxApi = createWxApi();

Page({
  data: {
    reasonLabels: REASON_LABELS,
    max: AFTER_SALE_DESCRIPTION_MAX,
    form: initialForm(),
    view: formView(initialForm()),
    /** 链接参数错误（没有订单 id）。 */
    error: '',
    /** 提交失败 / 校验提示（表单保留，改一改再点）。 */
    saveError: '',
    saveErrorRef: '',
    submitting: false,
  },

  orderId: '',
  traceId: '',

  /** @param {{id?: string}} options 订单详情带来的 `?id=…` */
  onLoad(options) {
    this.traceId = newTraceId();
    this.orderId = typeof options?.id === 'string' ? options.id : '';
    if (this.orderId === '') this.setData({ error: '没有找到要申请售后的订单，请从订单详情进入' });
  },

  onBack() {
    wxApi.navigateBack();
  },

  setForm(form) {
    this.setData({ form, view: formView(form), saveError: '', saveErrorRef: '' });
  },

  onReasonPick(e) {
    const idx = Number(e?.detail?.value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= REASON_LABELS.length) return;
    this.setForm({ ...this.data.form, reasonIndex: idx });
  },

  onInput(e) {
    const value = typeof e?.detail?.value === 'string' ? e.detail.value : '';
    this.setForm({ ...this.data.form, description: value });
  },

  onSubmit() {
    if (this.data.submitting === true || this.orderId === '') return;
    const checked = submitBody(this.data.form);
    if (!checked.ok) {
      this.setData({ saveError: checked.error, saveErrorRef: '' });
      return;
    }
    void this.submit(checked.body);
  },

  async submit(body) {
    this.setData({ submitting: true, saveError: '', saveErrorRef: '' });
    try {
      await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${encodeURIComponent(this.orderId)}/after-sales`,
        method: 'POST',
        data: body,
        traceId: this.traceId,
      });
    } catch (e) {
      const text = conflictText(e);
      this.setData(
        text === null ? { ...errorFields(e, 'saveError') } : { saveError: text, saveErrorRef: '' },
      );
      return;
    } finally {
      this.setData({ submitting: false });
    }
    wxApi.navigateBack();
  },
});
