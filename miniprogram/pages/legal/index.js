/**
 * 职责：法务页薄壳——`GET /terms` → vm → 渲染；条款正文只能"复制链接出去看"。
 *
 * @why 结算页的"阅读并同意购买条款"**必须有一个能真的读到条款的去处**：
 *      只有勾选框没有正文，等于让用户同意一份他看不到的文本——
 *      这在合规上比"没有勾选框"更糟（我们手上会有一份"用户已同意"的记录，
 *      而用户那头什么都没看到）。所以这一页不是附属功能，是勾选框的**另一半**。
 *
 * @why **不把条款正文搬进小程序**：正文的单一事实源是 `GET /terms` 的 `urls`
 *      指向的静态页（checkout 站）。小程序里再存一份，改条款时两处必然漂移，
 *      而版本号还是同一个——比没有更危险（@see ./index.vm.js 文件头 @why）。
 *
 * @why 用 `onShow` 而不是 `onLoad` 取数（与订单列表页同一口径）：
 *      条款版本是**会变的**，每次进屏都重取才拿得到当前生效的那一版；
 *      顺带的效果是"上次拉失败了，退出去再进来就是一次重试"，不需要额外的重试按钮。
 *
 * @limitation 一：**没有 web-view，也没有自动跳转**（D-49 已废 web-view）。
 *              复制链接后由用户自己去浏览器粘贴，是整个支付链路里唯一可行的外站路径
 *              （与支付页复制 Stripe 短链完全同一口径，@see utils/wx-api.js @limitation 十一）。
 * @limitation 二：复制失败时**给一句文案**而不是静默。宿主复制失败只有回调、不抛异常，
 *              页面没有任何变化——用户只会以为"这个按钮坏了"。
 *              兜底动作（长按链接手动复制）必须写出来，否则那句话等于没说。
 * @limitation 三：特商法表示（特定商取引法に基づく表示）**字段已就绪、值待公司登记**：契约 0.6.33 起 `/terms` 带
 *              `documents`（四类法务页三语地址，含 tokushoho）与 `seller`（商家信息，只含已配置字段），本页已在渲染
 *              （`sellerRows` + wxml 商家信息卡）。登记前服务端不下发占位值、卡片为空；登记后配 `SELLER_*` 即可，
 *              **不需要再立单元加字段**（独立审查 2026-10-13 【5】订正：原注释写"契约没有字段、要单独立单元"，与契约相反）。
 *
 * @see ./index.vm.js（版本与链接的转换，11 条单测）；../../utils/wx-api.js（setClipboardData）
 */
import { documentsView, legalState, sellerRows, termsView } from './index.vm.js';
import { errorFields } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

Page({
  data: {
    /** 当前生效的条款版本（空串 = 还没拿到 / 服务端没给）。 */
    version: '',
    /** vm `termsView` 的 `langs`：三个语种里**真正有 url**的那些。 */
    langs: [],
    /** 剩余清单 4-1：四类法务文档（vm `documentsView`）；为空时退回只显示用户协议的 `langs`。 */
    docs: [],
    /** 剩余清单 4-1：特商法商家信息（vm `sellerRows`）；为空时不显示这张卡。 */
    seller: [],
    /** 最近一次复制成功的语种 key（空串 = 还没复制过）。 */
    copied: '',
    loading: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
    /** 复制链接失败的提示（W-07：不复用取数错误，否则页面会说"没能取到条款"）。 */
    copyError: '',
    /** vm `legalState` 的输出：加载中 / 有条款 / 暂时没有。 */
    state: { showLoading: true, showList: false, showEmpty: false },
  },

  traceId: '',

  onLoad() {
    this.traceId = newTraceId();
  },

  onShow() {
    void this.load();
  },

  /** 取 `GET /terms`。失败**清空链接**并明示错误（留旧链接 = 给用户一个可能已经失效的地址）。 */
  async load() {
    // 重试时立刻进入"加载中"并收起旧错误（审查 2026-10-09）：页面渲染看的是 `state`，
    //   只设 loading 的话失败块原样挂到请求返回，"重试"看起来像没反应
    this.setData({
      loading: true,
      error: '',
      errorRef: '',
      state: legalState({ loading: true, langCount: 0 }),
    });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/terms`,
        traceId: this.traceId,
      });
      const view = termsView(res);
      const docs = documentsView(res);
      this.setData({
        version: view.version,
        langs: view.langs,
        docs,
        seller: sellerRows(res),
        copied: '',
        error: '',
        state: legalState({ loading: false, langCount: docs.length + view.langs.length }),
      });
    } catch (e) {
      this.setData({
        version: '',
        langs: [],
        docs: [],
        seller: [],
        ...errorFields(e),
        state: legalState({ loading: false, langCount: 0, ...errorFields(e) }),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 复制某个语种的条款链接。
   * @param {WechatMiniprogram.TouchEvent} e `data-url` / `data-key` 来自 wxml
   * @why 复制而不是跳转：小程序里打不开外站（@see @limitation 一）。
   * @why 记 `copied`（语种 key）而不是布尔：三个语种各有一个"复制"，
   *      一个布尔会让"复制了日语"在中文行上也显示"已复制"。
   */
  /**
   * 错误态里的「重试」（S4：状态块换成 `ws-state-block` 之后才有这个入口）。
   * @why `load()` 是只读的条款版本查询，重复调用没有副作用——所以这里的重试是安全的。
   *      ⚠️ 这个判断**不可**照搬到付款类动作（那里的重试必须走幂等键）。
   */
  onRetry() {
    void this.load();
  },

  onCopy(e) {
    const d = e?.currentTarget?.dataset;
    const url = typeof d?.url === 'string' ? d.url : '';
    const key = typeof d?.key === 'string' ? d.key : '';
    // url 为空的行 vm 已经过滤掉了；这里再挡一次是防 wxml 改坏了之后复制出空串
    if (url === '' || key === '') return;
    wxApi.setClipboardData({
      data: url,
      success: () => this.setData({ copied: key, copyError: '' }),
      // @see @limitation 二：失败要说一句话，并给出兜底动作
      // 复制失败与"取不到条款"分开（W-07）：条款列表还在，只是剪贴板没写进去
      // 全入口点击测试 2026-10-11：网址平时不显示，复制失败时才出现在各语种下面——提示随之改为"下面的链接"
      fail: () => this.setData({ copied: '', copyError: '复制失败，请长按下面的链接手动复制' }),
    });
  },
});
