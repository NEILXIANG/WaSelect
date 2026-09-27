/**
 * 职责：地址编辑页薄壳——表单输入 → `formErrors` 预检 → `toAddressInput` → POST/PUT → 出栈。
 *
 * @why **这一页没有 `index.vm.js`**：它的逻辑（模型/校验/请求体）全部住在
 *      `utils/address-form.js`（26 条单测），本页只剩"读输入、setData、发请求"三件事。
 *      硬抽一个 vm 只会产出把 `formErrors` 再包一层的空壳——
 *      约束十一要的是"逻辑可测"，不是"每个页面必须有一个同名文件"（vm-guard 亦不强制）。
 *
 * @why 编辑态要**再拉一次列表**而不是让列表页把整条地址传过来：
 *      契约没有 `GET /addresses/{id}`，而通过 URL query 传七个字段（含 `+1…` 与空格）
 *      要处理转义，转义出错的表现是"电话少一个 +"。多一次列表请求换掉这一整摊子。
 *
 * @limitation 一：`data-field` 必须落在 `ADDRESS_FIELDS` 白名单里才写入 form——
 *              wxml 的 `data-*` 是**外部输入**（可被改包篡改），用它直接拼 `setData` 键
 *              等于把任意字段写进请求体（服务端 40001，报错指向请求体不指向页面）。
 * @limitation 二：保存成功**出栈**而不是 `navigateTo` 列表页：后者会再压一层，
 *              表现为"返回键要按两次"（wx-api 的 navigateBack @why 同一条）。
 * @limitation 三：校验失败**只显示字段级错误**，不弹 toast（`showToast` 未登记——
 *              页面内文案可见、可测、不依赖宿主时序；@see wx-api @limitation 九）。
 *
 * @see ../../utils/address-form.js（模型/校验/请求体真源）；../address/index.js（列表页）
 */
import {
  ADDRESS_FIELDS,
  emptyForm,
  formErrors,
  formModel,
  toAddressInput,
} from '../../utils/address-form.js';
import { errorMessage } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

Page({
  data: {
    /** 表单模型（`ADDRESS_FIELDS` + is_default）。 */
    form: emptyForm(),
    /** 字段级错误（`{recipient: '…'}`）；空对象 = 无错误。 */
    errors: {},
    /** 第一条错误提示（顶部一行显示）。 */
    first: '',
    /** true = 编辑态（有 id）；false = 新增态。 */
    editing: false,
    loading: false,
    saving: false,
    /** 取数/提交错误文案（空串 = 无错误）。 */
    error: '',
  },

  /** 编辑的地址 id（空串 = 新增）。 */
  addressId: '',
  traceId: '',

  /** @param {{id?: string}} options 列表页带来的 `?id=…` */
  onLoad(options) {
    this.traceId = newTraceId();
    this.addressId = typeof options?.id === 'string' ? options.id : '';
    this.setData({ editing: this.addressId !== '' });
    if (this.addressId === '') return;
    void this.loadAddress();
  },

  /** 编辑态：拉列表找自己（@why 见文件头：契约无单条接口，query 传字段要转义）。 */
  async loadAddress() {
    this.setData({ loading: true });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/addresses`,
        traceId: this.traceId,
      });
      const list = Array.isArray(res) ? res : [];
      const found = list.find((a) => a && a.id === this.addressId);
      if (found === undefined) {
        // ⚠️ 找不到 = 已被删掉或不属于当前用户：**明示**而不是留一个空表单让用户重填一遍
        this.setData({ error: '这个地址已不存在（可能已被删除）' });
        return;
      }
      this.setData({ form: formModel(found) });
    } catch (e) {
      this.setData({ error: errorMessage(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 输入变更。
   * @why 只按白名单写字段（@see @limitation 一）：`data-field` 来自 wxml，等同外部输入。
   */
  onInput(e) {
    const field = e?.currentTarget?.dataset?.field;
    if (typeof field !== 'string' || !ADDRESS_FIELDS.includes(field)) return;
    const value = typeof e?.detail?.value === 'string' ? e.detail.value : '';
    // ⚠️ 同时清掉该字段的旧错误：用户正在改它，留着旧提示等于说他还没改对
    const errors = { ...this.data.errors };
    delete errors[field];
    this.setData({ [`form.${field}`]: value, errors, first: Object.values(errors)[0] ?? '' });
  },

  onToggleDefault() {
    this.setData({ 'form.is_default': !this.data.form.is_default });
  },

  /** 保存：先过 `formErrors`，不过就不发请求（@see @limitation 三）。 */
  onSave() {
    const result = formErrors(this.data.form);
    if (!result.ok) {
      this.setData({ errors: result.errors, first: result.first });
      return;
    }
    void this.submit();
  },

  async submit() {
    this.setData({ saving: true, error: '' });
    const body = toAddressInput(this.data.form);
    try {
      if (this.addressId === '') {
        await app.globalData.api({
          url: `${app.globalData.apiBase}/api/v1/addresses`,
          method: 'POST',
          data: body,
          traceId: this.traceId,
        });
      } else {
        await app.globalData.api({
          url: `${app.globalData.apiBase}/api/v1/addresses/${this.addressId}`,
          method: 'PUT',
          data: body,
          traceId: this.traceId,
        });
      }
    } catch (e) {
      // ⚠️ 服务端的拒单（格式/字段）也要显示出来：前端预检不是权威，
      //    只信预检的表现是"前端说对、提交失败"却没有任何提示。
      this.setData({ error: errorMessage(e) });
      return;
    } finally {
      this.setData({ saving: false });
    }
    wxApi.navigateBack();
  },
});
