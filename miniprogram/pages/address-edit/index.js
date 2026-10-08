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
  ENGLISH_ADDRESS_NOTE,
  emptyForm,
  formErrors,
  formModel,
  toAddressInput,
} from '../../utils/address-form.js';
import { errorFields } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import { STATE_LABELS, US_STATE_ROWS, stateIndexOf } from '../../utils/us-states.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

Page({
  data: {
    /** M-20（AJ-406）：表单前的"请用英文 / 拼音填写"说明与示例（utils/address-form.js）。 */
    englishNote: ENGLISH_ADDRESS_NOTE,
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
    /** **取数**错误文案（空串 = 无错误）；只在编辑态拉地址失败时出现。 */
    error: '',
    /**
     * **保存**错误文案（W-07）：与取数错误分开——保存失败时表单还在，用户要的是改一改再点，
     * 不是"返回列表重开这一页"（照做会丢掉刚填的整张表单）。
     */
    saveError: '',
    /** 州下拉的选项（剩余清单 4-5：`CA · California`；只给 USPS 真实存在的州码）。 */
    stateLabels: STATE_LABELS,
    /**
     * 下拉的初始选中项（扫描 W-04）：编辑已有地址时定位到它原来的州；没有 / 不认识 → 0。
     * 不绑它的话下拉总停在第 0 项 AL，用户打开看一眼点"确定"，州就悄悄变成 AL。
     */
    stateIndex: 0,
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
      const form = formModel(found);
      this.setData({ form, stateIndex: Math.max(0, stateIndexOf(form.state)) });
    } catch (e) {
      this.setData({ ...errorFields(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 输入变更。
   * @why 只按白名单写字段（@see @limitation 一）：`data-field` 来自 wxml，等同外部输入。
   */
  /**
   * 错误态里的次要动作：返回列表（S4：状态块换成 `ws-state-block` 之后才有这个入口）。
   * @why 这一页在**编辑态**才可能取数失败，而失败时表单是空的却写着"编辑地址"——
   *      用户会以为自己要重填一遍，其实只是没取到。给一个明确的"返回列表"，
   *      比让她自己猜返回键在哪（以及"返回会不会丢东西"）要好。
   *      ⚠️ 只出栈，不做任何写操作，因此没有任何副作用需要论证。
   */
  onBack() {
    wxApi.navigateBack();
  },

  onInput(e) {
    const field = e?.currentTarget?.dataset?.field;
    if (typeof field !== 'string' || !ADDRESS_FIELDS.includes(field)) return;
    const value = typeof e?.detail?.value === 'string' ? e.detail.value : '';
    // ⚠️ 同时清掉该字段的旧错误：用户正在改它，留着旧提示等于说他还没改对
    const errors = { ...this.data.errors };
    delete errors[field];
    this.setData({ [`form.${field}`]: value, errors, first: Object.values(errors)[0] ?? '' });
  },

  /**
   * 州下拉选中（剩余清单 4-5）。
   * @why 整体写 `form` 而不是 `form.state` 路径：与其余字段的 onInput 等价，且不依赖数据路径写法。
   */
  onStatePick(e) {
    const idx = Number(e?.detail?.value);
    const row = Number.isInteger(idx) ? US_STATE_ROWS[idx] : undefined;
    if (row === undefined) return;
    const errors = { ...this.data.errors };
    delete errors.state;
    this.setData({
      form: { ...this.data.form, state: row.code },
      stateIndex: idx,
      errors,
      first: Object.values(errors)[0] ?? '',
    });
  },

  onToggleDefault() {
    this.setData({ 'form.is_default': !this.data.form.is_default });
  },

  /** 保存：先过 `formErrors`，不过就不发请求（@see @limitation 三）。 */
  onSave() {
    // 保存在途时忽略（W-03）：POST /addresses 没有幂等键，双击会建出两条一样的地址
    if (this.data.saving === true) return;
    const result = formErrors(this.data.form);
    if (!result.ok) {
      this.setData({ errors: result.errors, first: result.first });
      return;
    }
    void this.submit();
  },

  async submit() {
    this.setData({ saving: true, saveError: '', saveErrorRef: '' });
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
      this.setData({ ...errorFields(e, 'saveError') });
      return;
    } finally {
      this.setData({ saving: false });
    }
    wxApi.navigateBack();
  },
});
