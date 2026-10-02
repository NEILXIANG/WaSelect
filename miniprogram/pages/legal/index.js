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
 * @limitation 三：**没有特商法表示（特定商取引法に基づく表示）**。它是日本法对通信販売的硬要求，
 *              但契约的 `/terms` 目前只给条款版本与三语种链接，**没有特商法字段**，
 *              且主体名称 / 所在地 / 电话要等日本公司登记完才有真值——
 *              现在补只能全是占位，那比明确没有更糟（占位会被当成真值写进订单）。
 *              登记完成后单独立单元：契约加字段 + 服务端 + 本页补一节。
 *
 * @see ./index.vm.js（版本与链接的转换，11 条单测）；../../utils/wx-api.js（setClipboardData）
 */
import { legalState, termsView } from './index.vm.js';
import { errorMessage } from '../../utils/error-text.js';
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
    /** 最近一次复制成功的语种 key（空串 = 还没复制过）。 */
    copied: '',
    loading: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
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
    this.setData({ loading: true });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/terms`,
        traceId: this.traceId,
      });
      const view = termsView(res);
      this.setData({
        version: view.version,
        langs: view.langs,
        copied: '',
        error: '',
        state: legalState({ loading: false, langCount: view.langs.length }),
      });
    } catch (e) {
      this.setData({
        version: '',
        langs: [],
        error: errorMessage(e),
        state: legalState({ loading: false, langCount: 0, error: errorMessage(e) }),
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
      success: () => this.setData({ copied: key, error: '' }),
      // @see @limitation 二：失败要说一句话，并给出兜底动作
      fail: () => this.setData({ copied: '', error: '复制失败，请长按上方链接手动复制' }),
    });
  },
});
