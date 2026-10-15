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
import { addressRows, deleteConfirmText, emptyState, errorTitle } from './index.vm.js';
import { formModel, toAddressInput } from '../../utils/address-form.js';
import { contactFields, errorFields } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
// UX-008（AJ-556）：同一个"列表槽位"连续发请求时只接受最后一次的结果。
// @why 与另外六页同一套判据（`utils/request-seq.js`），不在这里另立一份。
import { isStale, nextSeq } from '../../utils/request-seq.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 编辑页路径（跳转路径只在这一处出现）。 */
const EDIT_PAGE = '/pages/address-edit/index';
/** 「我的」（tab 页）：客服联系方式在那里（AJ-433）。 */
const USER_PAGE = '/pages/user/index';

Page({
  data: {
    /** vm `addressRows` 的输出。 */
    rows: [],
    loading: false,
    /** 错误块标题（vm `errorTitle`：取列表 / 删除 / 设默认各自一句）。 */
    errorTitle: errorTitle('load'),
    /** 错误文案（空串 = 无错误）。 */
    error: '',
    /** AJ-433：错误态按钮去客服（账号被拉黑）而不是重试。 */
    errorContact: false,
    /** 空态开关（**请求失败时不亮**，@see index.vm.js 的 emptyState）。 */
    empty: false,
    /** true = 从结算页进来选地址（点条目即回传并出栈）。 */
    pick: false,
  },

  /** 服务端原始地址列表（`PUT` 组装请求体要用，@see @limitation 一）。 */
  rawList: [],
  traceId: '',
  /**
   * 在途的那一行 id（删除 / 设为默认）——独立审查 2026-10-13 【1】：原先两个动作没有在途守卫，
   * 连点删除第二次打到已删 id 会显示「删除没有成功，地址还在」（其实已删）；对两行快速连点「设为默认」会发出并发 PUT，
   * 最终默认地址可能不是最后点的那个，结算页随之预选错地址。有在途就忽略后续点击，wxml 把那一行写成「处理中…」。
   */
  busyId: '',
  /**
   * 页面是否还活着（UX-008 / AJ-556）：`onUnload` 置 false。
   * @why 删完地址去编辑页、再从编辑页按返回直接退出整条栈是常有的事；
   *      那时在途的列表请求回来仍会 `setData`（`wx` 侧只会在控制台留一行指向 setData 的报错，
   *      排查方向会被引偏）。@see ../pay/index.js `alive` 的 @limitation：
   *      它只挡"异步回来时页面已销毁"，**不是** `loadSeq` 的替代品——
   *      `loadSeq` 管同一页两份响应谁算新，`alive` 管这一页还在不在。
   */
  alive: true,
  /**
   * 取数序号（UX-008 / AJ-556）：`onShow` 与"删除 / 设默认后的重取"会并发 `load`，
   * 先发后到的旧响应会把新列表盖回去（例如删完重取拿到了新列表，随后一条在途的旧响应
   * 又把已删地址画出来）。
   */
  loadSeq: 0,

  /** @param {{pick?: string}} options `?pick=1` = 选择模式 */
  onLoad(options) {
    this.traceId = newTraceId();
    this.busyId = '';
    this.alive = true;
    this.setData({ pick: options?.pick === '1' });
  },

  onUnload() {
    this.alive = false;
    // 与 ../order-detail/index.js 同口径：把序号推到新值，在途响应回来一律判为过期
    this.loadSeq = nextSeq(this.loadSeq);
  },

  /**
   * 进页取列表。从结算页（选择模式）新增地址回来时直接选中它返回结算页（三端走查小白视角 2026-10-10）。
   * @why 原先保存后落回本页，还得再点「用这个地址」；页面最显眼的是实心「新增地址」，小白容易再新增一条。
   *      交接值是一次性的：不论用没用上都读走即清，不留给下一次。
   */
  onShow() {
    const added = app.globalData.justAddedAddressId;
    app.globalData.justAddedAddressId = '';
    if (this.data.pick && typeof added === 'string' && added !== '') {
      app.globalData.pickedAddressId = added;
      wxApi.navigateBack();
      return;
    }
    void this.load();
  },

  /**
   * 取地址列表。失败**清空列表**并明示错误（留旧数据 = 显示已删掉的地址）。
   *
   * @why 领号（UX-008 / AJ-556）：删除 / 设默认成功后都会 `await this.load()`，而那时
   *      `onShow` 发起的那一次可能还在途——先发后到会把已经删掉的地址再画回来。
   *      ⚠️ 序号**不会**误伤"删除后重取"这条路：那次 `load()` 是在删除响应**之后**才领号，
   *      它一定是当时最新的号（@see `removeAddress` / `onSetDefault` 末尾 `await this.load()` 处的注释）。
   */
  async load() {
    const seq = (this.loadSeq = nextSeq(this.loadSeq));
    this.setData({ loading: true });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/addresses`,
        traceId: this.traceId,
      });
      if (isStale(seq, this.loadSeq) || !this.alive) return;
      const list = Array.isArray(res) ? res : [];
      this.rawList = list;
      const rows = addressRows(list);
      this.setData({
        rows,
        error: '',
        errorRef: '',
        errorContact: false,
        empty: emptyState(rows, '').showEmpty,
      });
    } catch (e) {
      if (isStale(seq, this.loadSeq) || !this.alive) return;
      this.rawList = [];
      this.setData({
        rows: [],
        ...errorFields(e),
        ...contactFields(e),
        errorTitle: errorTitle('load'),
        empty: false,
      });
    } finally {
      if (!isStale(seq, this.loadSeq) && this.alive) this.setData({ loading: false });
    }
  },

  /**
   * 错误态里的「重试」（S4：状态块换成 `ws-state-block` 之后才有这个入口）。
   * @why `load()` 是整表替换的只读请求，重复调用没有副作用——所以这里的重试是安全的。
   *      ⚠️ 这个判断**不可**照搬到付款类动作：那里的重试必须走幂等键，要单独论证。
   */
  onRetry() {
    // AJ-433：账号被拉黑（40301）时重试永远不会成功，出口是「我的」里的客服
    if (this.data.errorContact === true) {
      wxApi.switchTab({ url: USER_PAGE });
      return;
    }
    void this.load();
  },

  /**
   * 新增（不带 id = 新增态）。
   * @why 不再另加一层连点守卫（`acceptAddTap`）：`utils/wx-api.ts` 的 ITX-01 已在共享层
   *      对"同一地址 600ms 内只跳一次"做了统一拦截，这里再加一份就是同一条规则的第二份实现
   *      （约束九 / H7）。真机上双击「新增地址」只进一次编辑页，已由 ITX-01 保证。
   */
  onAdd() {
    wxApi.navigateTo({ url: EDIT_PAGE });
  },

  onEdit(e) {
    const id = this.idOf(e);
    if (id === '') return;
    wxApi.navigateTo({ url: `${EDIT_PAGE}?id=${encodeURIComponent(id)}` });
  },

  /** 删除：模态确认 → `DELETE /addresses/{id}`。 */
  onDelete(e) {
    const id = this.idOf(e);
    if (id === '') return;
    wxApi.showModal({
      title: '删除地址',
      content: deleteConfirmText(this.data.rows.find((r) => r.id === id)),
      confirmText: '删除',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm !== true) return;
        void this.removeAddress(id);
      },
    });
  },

  async removeAddress(id) {
    if (this.busyId !== '') return;
    this.busyId = id;
    this.setData({ busyId: id });
    try {
      await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/addresses/${id}`,
        method: 'DELETE',
        traceId: this.traceId,
      });
    } catch (err) {
      this.setData({
        ...errorFields(err),
        ...contactFields(err),
        errorTitle: errorTitle('delete'),
      });
      return;
    } finally {
      this.busyId = '';
      this.setData({ busyId: '' });
    }
    // ⚠️ 这里的重取**必须**照常生效（UX-008 / AJ-556 的回归点）：它此刻才领号，
    //    序号一定是最新的，不会被判成过期；若把领号提到 `removeAddress` 开头就会反过来。
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
    if (this.busyId !== '') return;
    this.busyId = id;
    this.setData({ busyId: id });
    try {
      await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/addresses/${id}`,
        method: 'PUT',
        data: toAddressInput({ ...formModel(raw), is_default: true }),
        traceId: this.traceId,
      });
    } catch (err) {
      this.setData({
        ...errorFields(err),
        ...contactFields(err),
        errorTitle: errorTitle('default'),
      });
      return;
    } finally {
      this.busyId = '';
      this.setData({ busyId: '' });
    }
    await this.load();
  },

  /**
   * 点整张地址卡（全入口点击测试 2026-10-11）：选择模式 = 选中它；管理模式 = 进编辑。
   * @why 原先选择模式要在「编辑 / 删除 / 设为默认 / 用这个地址」四个小字里找最后一个，最该点的反而最不显眼；
   *      主流（微信 / 京东）选地址都是点整张卡。卡内的动作用 catchtap，不会连带触发这里。
   */
  onCardTap(e) {
    if (this.data.pick === true) this.onPick(e);
    else this.onEdit(e);
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
