/**
 * 职责：地址列表页薄壳——`GET /addresses` → vm → 渲染；编辑/删除/设默认/选择。
 *
 * @why 用 `onShow` 而不是 `onLoad` 取数：从编辑页 `navigateBack` 回来**不会**触发 onLoad
 *      （列表页一直在栈里），只看 onLoad 的表现是"存了地址，返回列表看不到"——
 *      与购物车页同一条理由。
 *
 * @why 删除走 `showModal` 二次确认而不是直接删：地址不可撤销，
 *      手滑删掉常用地址之后没有任何日志能证明它是误操作（wx-api @limitation 九 同口径）。
 *
 * @limitation 一：**保留原始列表**（`this.rawList`）而不只留 vm 行：
 *              `PUT /addresses/{id}` 要的是完整 `AddressInput` 七个字段，
 *              而 vm 行为了渲染把它们并成了 `region` 一个字符串——
 *              拿渲染行去组装请求体会丢字段，服务端 40001 且报错指向请求体不指向页面。
 * @limitation 二："选择模式"（`?pick=1`）的回传走 `globalData.pickedAddressId` 一次性交接：
 *              小程序没有"带返回值返回"的机制（没有 Intent / onActivityResult），
 *              可选的三条路是 eventChannel、globalData、storage。
 *              选 globalData：eventChannel 要求栈内通信且不可跨多次跳转，storage 会留残留键。
 *              ⚠️ 代价是它**必须被消费方读走后立即清空**，否则下一次进结算页会拿到过期选择。
 *
 * @see ./index.vm.js（视图逻辑真源）；../../utils/address-form.js（请求体与摘要真源）
 */
import { addressRows, emptyState } from './index.vm.js';
import { formModel, toAddressInput } from '../../utils/address-form.js';
import { errorMessage } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 编辑页路径（跳转路径只在这一处出现）。 */
const EDIT_PAGE = '/pages/address-edit/index';

Page({
  data: {
    /** vm `addressRows` 的输出。 */
    rows: [],
    loading: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
    /** 空态开关（**请求失败时不亮**，@see index.vm.js 的 emptyState）。 */
    empty: false,
    /** true = 从结算页进来选地址（点条目即回传并出栈）。 */
    pick: false,
  },

  /** 服务端原始地址列表（`PUT` 组装请求体要用，@see @limitation 一）。 */
  rawList: [],
  traceId: '',

  /** @param {{pick?: string}} options `?pick=1` = 选择模式 */
  onLoad(options) {
    this.traceId = newTraceId();
    this.setData({ pick: options?.pick === '1' });
  },

  onShow() {
    void this.load();
  },

  /** 取地址列表。失败**清空列表**并明示错误（留旧数据 = 显示已删掉的地址）。 */
  async load() {
    this.setData({ loading: true });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/addresses`,
        traceId: this.traceId,
      });
      const list = Array.isArray(res) ? res : [];
      this.rawList = list;
      const rows = addressRows(list);
      this.setData({ rows, error: '', empty: emptyState(rows, '').showEmpty });
    } catch (e) {
      this.rawList = [];
      this.setData({ rows: [], error: errorMessage(e), empty: false });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 新增（不带 id = 新增态）。 */
  onAdd() {
    wxApi.navigateTo({ url: EDIT_PAGE });
  },

  onEdit(e) {
    const id = this.idOf(e);
    if (id === '') return;
    wxApi.navigateTo({ url: `${EDIT_PAGE}?id=${id}` });
  },

  /** 删除：模态确认 → `DELETE /addresses/{id}`。 */
  onDelete(e) {
    const id = this.idOf(e);
    if (id === '') return;
    wxApi.showModal({
      title: '删除地址',
      content: '删除后不可恢复，确定删除？',
      confirmText: '删除',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm !== true) return;
        void this.removeAddress(id);
      },
    });
  },

  async removeAddress(id) {
    try {
      await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/addresses/${id}`,
        method: 'DELETE',
        traceId: this.traceId,
      });
    } catch (err) {
      this.setData({ error: errorMessage(err) });
      return;
    }
    await this.load();
  },

  /**
   * 设为默认：`PUT` 整条地址并把 `is_default` 置真。
   * @why 用整条而不是只传 is_default：契约的 `PUT` 要的是完整 `AddressInput`，
   *      只传一个字段会被 40001 拒——而"点了设为默认没反应"是最难自查的一类失效。
   */
  async onSetDefault(e) {
    const id = this.idOf(e);
    if (id === '') return;
    const raw = this.rawList.find((a) => a && a.id === id);
    if (raw === undefined) return;
    try {
      await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/addresses/${id}`,
        method: 'PUT',
        data: toAddressInput({ ...formModel(raw), is_default: true }),
        traceId: this.traceId,
      });
    } catch (err) {
      this.setData({ error: errorMessage(err) });
      return;
    }
    await this.load();
  },

  /** 选择模式：回传给结算页并出栈（@see @limitation 二 的一次性交接）。 */
  onPick(e) {
    const id = this.idOf(e);
    if (id === '') return;
    app.globalData.pickedAddressId = id;
    wxApi.navigateBack();
  },

  /** 取 wxml 的 `data-id`（取不到 = 空串，而不是 undefined）。 */
  idOf(e) {
    const id = e?.currentTarget?.dataset?.id;
    return typeof id === 'string' ? id : '';
  },
});
