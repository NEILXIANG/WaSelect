/**
 * 职责：支付页薄壳——拉通道 → 选通道 → `POST /orders/{id}/pay` → 按 `payPlan` 执行。
 *
 * @why 支付方式**一律由服务端下发**（`GET /pay/channels`）并按 `entryMode` 分流，
 *      前端不写死通道名、不写死按钮：上下线一个通道改配置即可，无需发版（ADR-28/F11）。
 *      ⚠️ 这是本项目"可扩展性"的硬要求，不是风格偏好——
 *      按 `channel === 'stripe'` 分支的代码在新增支付方式那天必须改前端重新提审。
 *
 * @why `amount_jpy` 从 `GET /orders/{id}` 取而不是从上一页带过来：
 *      金额是**服务端权威**数据，跨页传参意味着"页面上显示的金额可以被改包篡改"，
 *      而通道过滤正是按金额做的（大额可能不开放某些通道）。
 *
 * @limitation 一：**没有轮询支付结果**。支付完成靠服务端回调（`/pay/callback/{channel}`），
 *              前端不知道何时完成。copylink 场景（浏览器里付）更是无法感知——
 *              所以引导屏只给"支付完成后回到这里查看订单"，不假装有实时状态。
 *              @tradeoff 代价是用户要自己回来看；MVP 可接受（回调落库后订单页即是真值）。
 * @limitation 二：**跳转方式由"目标是不是 tabBar 页"决定**，不看"我想不想留返回栈"。
 *              ⚠️ 这里曾经写"『查看订单』按钮当前禁用——`pages/order` 未落地"——**早已不成立**
 *              （S5 之后订单列表就是底部 tab 之一）。而顺着那句旧注释去看的人会以为这个按钮
 *              现在仍然是坏的，从而不去怀疑跳转方式——这正是本次真缺陷能活到今天的原因（MP-02 / AJ-366）。
 *              现状：`pages/order` 与 `pages/home` **都是 tabBar 页** ⇒ 只能 `switchTab`；
 *              `redirectTo` / `navigateTo` 跳 tabBar 页会被宿主**直接拒绝**，表现是"点了没反应"。
 *              ⚠️ 代价是 `switchTab` 不能带 query——这两处都不需要带（订单 id 走 `this.orderId`）。
 * @limitation 三：`requestPayment` 的**取消与失败一视同仁**（wx-api @limitation 十）：
 *              两者都停在支付页，订单仍是 pending_payment，用户可再点一次。
 *              解析宿主 fail 的文案去区分"取消 vs 失败"等于把宿主文案当契约。
 * @limitation 四：幂等键**一次意图一个、重试复用**（`intentKey.acquire()`），
 *              与结算页同一口径（A5，2026-09-29）。两处会作废键：
 *              **换通道**（同键重放会拿回上一个通道的凭据）与支付已发起成功。
 *              发起失败**不**作废——弱网下用户再点一次必须还是同一个键，
 *              否则同一张单会发起两次支付。
 * @limitation 五：**在途不再发起**（B6 / AJ-201）：上一次 `POST /orders/{id}/pay`
 *              还没回来时点第二个通道/再点一次，直接不动。服务端有幂等键兜底
 *              （同键不会建第二个会话），但发起支付要调机构、一次最长 6s，
 *              连接池只有 10 条时连点就是自己把自己排队——这里挡的是浪费，不是正确性。
 *
 * @see ./index.vm.js（点一下该做什么：纯函数，约束十一）；
 *      ../../utils/pay-plan.js（通道渲染 / 实扣金额与 §14.2 提示条 / 下一步做什么）；
 *      ../../utils/idempotency.js（幂等键生命周期）；
 *      index.vm.js `channelCountry`（通道过滤的目的国：取订单收货地址，P2-39）
 */
import { CHARGE_CURRENCY_ORDER, chargeOptions, payNotice, payPlan } from '../../utils/pay-plan.js';
import { createIntentIdempotency } from '../../utils/idempotency.js';
import { isStale, nextSeq } from '../../utils/request-seq.js';
import { errorFields } from '../../utils/error-text.js';
import { countdownText } from '../../utils/countdown.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import { markExternalPay, recentExternalPay } from '../../utils/external-pay.js';
import {
  EXPIRED_CLOSED_TEXT,
  PAY_FAIL_TEXT,
  afterIntent,
  channelCountry,
  closedScreen,
  copyResult,
  leavesAfterAuto,
  onShowAction,
  payPageView,
  payStartDecision,
  recheckAfterPayError,
} from './index.vm.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 订单列表页路径（跳转路径只在这一处出现）。 */
const ORDER_PAGE = '/pages/order/index';

/** 订单详情页路径（支付成功后去这里：这一单的最新真值在详情页，不在本页）。 */
const ORDER_DETAIL_PAGE = '/pages/order-detail/index';

/**
 * 首页路径（没付成的单"重新下单"的落点，MP3-01）。
 * @why 重新下单的**入口**在商品页，不在购物车：这一单的商品可能已经下架或改价，
 *      直接跳购物车等于让人去结算一条服务端会拒绝的旧数据。首页是唯一不会说谎的起点。
 * @why 用 `switchTab`：首页是 tabBar 页，`redirectTo` 对 tabBar 页会被宿主拒绝（AJ-366 / MP-02）；
 *      switchTab 同样会把支付页移出返回栈。（复核 2026-10-06 订正原"用 redirectTo"。）
 */
const HOME_PAGE = '/pages/home/index';

Page({
  data: {
    /** `chargeOptions` 的输出：每个通道带实扣币种与金额（§14.2，AJ-180）。 */
    channels: [],
    /** 剩余清单 4-8：取到通道但一个都没有（金额 / 地区不支持）→ 显示空态而不是一片空白。 */
    noChannel: false,
    /** §14.2 支付前提示条（逐行文案；空数组 = 不渲染）。 */
    notice: [],
    /** 订单已不可支付时的说明（空串 = 正常列通道；B35 / AJ-218）。 */
    closedText: '',
    /** 没付成时才为真：给一个"去首页重新下单"的出口（MP3-01；文案与按钮必须同生共死）。 */
    goHome: false,
    /** 订单合计（JPY 整数）；null = 还没拿到。 */
    totalJpy: null,
    /** 引导屏文案（copylink / auto / unsupported）；title 空串 = 不渲染引导屏。 */
    guide: { title: '', body: '', actionText: '', steps: [] },
    /** 剩余清单 4-11：待付款倒计时文案（utils/countdown.js）；空串 = 不显示。 */
    countdown: '',
    /** copylink 的短链（D-49：银行卡唯一入口）。 */
    payUrl: '',
    /** 短链是否已复制成功（决定按钮文案；失败由 `error` 显示并给兜底动作）。 */
    copied: false,
    loading: false,
    paying: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
    /**
     * **上一次支付动作**的结果（空串 = 没有；MP3-07）。
     * @why 与 `error` 分开：`error` 是"取数出错"，每次重取都要清；
     *      而"支付未完成"是用户刚做过的那件事的结论，
     *      拉起收银台会触发 onShow → 重取，混在 `error` 里就会被自己清掉。
     */
    payResult: '',
    /** 浏览器付款后的"确认中"提示（W-02）；空串 = 不显示。 */
    confirmNote: '',
  },

  /** 订单 id（空串 = 没带过来，此时不取数）。 */
  orderId: '',
  /** 幂等键的生命周期器（重试复用，同 checkout 的口径）。 */
  intentKey: null,
  /** 上一次发起支付用的通道（空串 = 还没发起过）。 */
  lastChannel: '',
  traceId: '',
  /** 是否已经取过一次数（`onShow` 的刷新只对"第二次及以后"生效，避免进页面取两遍）。 */
  loaded: false,
  /** 浏览器付款后"确认中"的重查次数与定时器（W-02）。 */
  statusRetries: 0,
  statusTimer: null,
  /** 倒计时句柄与截止时刻（剩余清单 4-11）。 */
  countdownTimer: null,
  expiresAt: undefined,
  /** 整页重取的序号（MP3-07：连续切前后台会并发两个 load，只接受最后一次的结果）。 */
  loadSeq: 0,

  /** @param {{orderId?: string}} options 结算页带来的 `?orderId=…` */
  onLoad(options) {
    this.traceId = newTraceId();
    this.intentKey = createIntentIdempotency();
    this.orderId = typeof options?.orderId === 'string' ? options.orderId : '';
    if (this.orderId === '') {
      this.setData({ error: '缺少订单 id' });
      return;
    }
    void this.load();
  },

  /**
   * 取订单（拿权威金额）→ 按扣款币种顺序逐个取通道（按金额过滤）。串行：后者依赖前者的金额。
   * @why 逐币种查（CHARGE_CURRENCY_ORDER）而不是只查 JPY：只对外声明 USD 的银行卡通道只在 USD 下列出，
   *      只查 JPY 时它**永远不出现**（AJ-180）。
   */
  async load() {
    // 清掉上一次的错误：不清的话旧错误会一直挂在重新取回来的内容上面
    // ⚠️ `payResult` **不在这里清**（MP3-07）：它是"上一次支付的结果"，不是"上一次取数的错误"。
    //    微信收银台取消后会触发 onShow → reload，把"支付未完成"抹掉等于什么都没说。
    this.setData({ loading: true, error: '', errorRef: '', noChannel: false });
    // ⚠️ 领号（MP3-07）：连续两次切前后台会并发两个 load，
    //    旧的那个若后到，会把"该订单已付款"旁边的支付方式**盖回去**——
    //    首页与购物车在 B36 里已经用序号修过同一类问题，支付页没跟上。
    const seq = (this.loadSeq = nextSeq(this.loadSeq));
    try {
      const order = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}`,
        traceId: this.traceId,
      });
      if (isStale(seq, this.loadSeq)) return;
      const total = Number.isInteger(order?.total_jpy) ? order.total_jpy : null;
      // B35 / AJ-218：已付 / 已关 / 已退款的单**不列支付方式**（点了就是 40902）
      // P2-35：待付款但已过 expires_at 同样不列（时间由这里传入，vm 不读时钟）
      const view = payPageView(order, Date.now());
      this.setData({ totalJpy: total, closedText: view.closedText });
      if (!view.payable) {
        // 整个 view 交出去：文案与"给不给重新下单的出口"是同一次判断的两个产物
        this.stopCountdown();
        this.setData({ ...closedScreen(view), countdown: '' });
        return;
      }
      // 剩余清单 4-11：可付的单才倒计时
      this.expiresAt = order?.expires_at;
      this.startCountdown();
      if (total === null) {
        this.setData({ error: '订单金额还没确定，请稍后再试' });
        return;
      }
      const listings = [];
      // P2-39：目的国取订单收货地址（缺失才回落默认），不写死国家
      const country = channelCountry(order);
      for (const currency of CHARGE_CURRENCY_ORDER) {
        const resp = await app.globalData.api({
          url: `${app.globalData.apiBase}/api/v1/pay/channels?country=${country}&currency=${currency}&amount_jpy=${total}`,
          traceId: this.traceId,
        });
        listings.push({ currency, resp });
      }
      if (isStale(seq, this.loadSeq)) return;
      const channels = chargeOptions(listings, order);
      this.setData({
        channels,
        notice: channels.length > 0 ? payNotice(channels, order) : [],
        // 剩余清单 4-8：可付的单却一个通道都没有 → 空态（说明 + 重试 + 联系客服），不是空白屏
        noChannel: channels.length === 0,
      });
    } catch (e) {
      if (isStale(seq, this.loadSeq)) return;
      this.setData({ ...errorFields(e) });
    } finally {
      // 过期请求不能把 loading 清掉（新的还在途中）
      if (!isStale(seq, this.loadSeq)) this.setData({ loading: false });
      // 首屏由 onLoad 触发；`onShow` 的刷新只对"已经取过一次"之后生效
      // （微信里 onLoad 与 onShow 会连着各触发一次，不挡就是每次进页面取两遍）
      this.loaded = true;
    }
  },

  /**
   * 从后台或上一页回来时重新取数（B35 / AJ-218）。
   * @why 支付完成的真值在服务端回调里，本页不轮询；用户去浏览器付完款再回来，
   *      只有重新取数才能把"已付款"显示出来——否则支付方式按钮还挂着，点了就是 40902。
   *      判断在 `onShowAction`（copylink / 引导屏 / 在途 三种情况不刷新）。
   */
  onShow() {
    if (this.loaded !== true) return;
    if (this.orderId === '') return;
    const action = onShowAction({
      payUrl: this.data.payUrl,
      guideTitle: this.data.guide?.title,
      paying: this.data.paying,
      // MP3-07：整页重取在途时不该再排一次——上一次的通道列表回来之前又发一轮，
      // 只是把自己排队（发起支付这条路要调机构，一次最长 6s）。
      loading: this.data.loading === true,
    });
    if (action === 'reload') void this.load();
    else if (action === 'status') {
      // 扫描 W-01：onHide 停了表，"只查状态"这条路不走 load()——不在这里重启，倒计时就停在离开那一秒
      if (this.expiresAt !== undefined && this.data.closedText === '') this.startCountdown();
      void this.checkStatus();
    }
  },

  /**
   * 只查订单状态（copylink 屏 / 引导屏回到前台时用，AJ-227）。
   * @why 不调 `load()`：那会重取支付方式并可能改写屏幕——用户切出去就是为了粘贴这条短链，
   *      回来发现它没了等于把人回家的路拆掉。这里只在"**已经不需要支付**"时才动页面。
   * @why 失败**静默**：这是一次顺手的核对，不是用户发起的动作；
   *      网络抖一下就在他正在用的短链上面盖一条"加载失败"，比什么都不说更糟。
   *      下一次回到前台还会再查，且"查看订单"始终可点。
   */
  async checkStatus() {
    try {
      const order = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}`,
        traceId: this.traceId,
      });
      const view = payPageView(order, Date.now());
      if (!view.payable) {
        this.stopCountdown();
        this.setData({ ...closedScreen(view), confirmNote: '' });
        return;
      }
      // 仍是待付款、但刚在浏览器里发起过付款（W-02）：多半是支付通知还在路上。
      // 显示"确认中"并有限次重查；两次之后放弃假设，不让页面永远停在"确认中"。
      if (recentExternalPay(app.globalData.externalPay, this.orderId, Date.now())) {
        if (this.statusRetries >= 2) {
          this.setData({ confirmNote: '' });
          return;
        }
        this.setData({
          confirmNote: '如已在浏览器完成付款，结果正在确认，请稍候…（请勿重复付款）',
        });
        this.statusRetries += 1;
        if (this.statusTimer !== null) clearTimeout(this.statusTimer);
        this.statusTimer = setTimeout(() => void this.checkStatus(), 2000 * this.statusRetries);
      }
    } catch {
      // 见上：静默
    }
  },

  onHide() {
    // 离开前台就停掉重查；回来时 onShow 会重新开始一轮
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.statusRetries = 0;
    this.stopCountdown();
  },

  onUnload() {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.stopCountdown();
  },

  /**
   * 倒计时（剩余清单 4-11）：每秒按本机时钟重算一次文案；到点停表（文案由 countdown.js 给）。
   * @why 用链式 setTimeout 而不是 setInterval：小程序端全局白名单（eslint）只登记了 setTimeout / clearTimeout，
   *      setInterval 在小程序运行时的可用性这次没找到官方页可核（文档链接 404），不凭记忆引入新全局。
   */
  startCountdown() {
    this.stopCountdown();
    const tick = () => {
      const c = countdownText(this.expiresAt, Date.now());
      if (c.expired) {
        // P2-35：到点不只是改文案——收起通道换关闭屏（按钮还能点 = 付款落成迟到款），
        // 再向服务端核对一次真值（可能其实已付，那就换成"无需再支付"）。
        this.countdownTimer = null;
        this.setData({
          ...closedScreen({ closedText: EXPIRED_CLOSED_TEXT, goHome: true }),
          confirmNote: '',
        });
        void this.checkStatus();
        return;
      }
      this.setData({ countdown: c.text });
      this.countdownTimer = setTimeout(tick, 1000);
    };
    tick();
  },

  stopCountdown() {
    if (this.countdownTimer !== null && this.countdownTimer !== undefined)
      clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
  },

  /** 选一个通道 → 发起支付。判断全在 `index.vm.js`（约束十一：薄壳只做编排）。 */
  onPay(e) {
    const decision = payStartDecision({
      paying: this.data.paying === true,
      channel: e?.currentTarget?.dataset?.channel,
      lastChannel: this.lastChannel,
      hasKey: this.intentKey !== null,
      // P2-35：关闭屏（含倒计时到点）之后不再发起
      closed: this.data.closedText !== '',
    });
    if (decision.kind === 'ignore') return;
    // ⚠️ 换通道 = 请求参数变了：沿用旧键会被服务端**重放成上一个通道的 intent**，
    //    用户点了 B 却拿到 A 的支付凭据（同键同参才算重放，参数不同就不是）。
    //    必须在 acquire **之前**作废，否则拿到的是旧键。
    if (decision.retireKey) this.intentKey.retire();
    this.lastChannel = decision.channel;
    const { key } = this.intentKey.acquire();
    void this.startPay(decision.channel, key);
  },

  async startPay(channel, idemKey) {
    // 新的一次发起 → 上一次的"支付结果"不再成立（它描述的是上一次动作）
    this.setData({ paying: true, error: '', payResult: '' });
    try {
      const intent = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}/pay`,
        method: 'POST',
        data: { channel },
        idempotencyKey: idemKey,
        traceId: this.traceId,
      });
      this.run(intent);
    } catch (err) {
      this.setData({ ...errorFields(err) });
      // P2-40：40902 / 40904 多半是这张单已经付了或关了——重查一次，由 payPageView 决定换不换关闭屏
      if (recheckAfterPayError(err?.code)) void this.checkStatus();
    } finally {
      this.setData({ paying: false });
    }
  },

  /** 按 `payPlan` 的判别联合执行（**不认通道名**，@see 文件头）。 */
  run(intent) {
    const plan = payPlan(intent);
    if (plan.kind === 'in_app') {
      // ⚠️ 换通道必须先把上一次的短链收掉（MP3-03）：服务端已经作废了那个银行卡支付行，
      //    这条短链再被复制去浏览器就是失效页；浏览器里早先开着的托管页仍可付款，
      //    与微信里这一笔撞车会多出一笔迟到款。
      this.setData(afterIntent(plan));
      wxApi.requestPayment({
        ...plan.params,
        // B35 / AJ-218：成功必须**离开这一页**——以前没有 success 回调，
        // 微信支付成功后页面纹丝不动，用户再点一次得 40902（订单其实已经付了）。
        // 用 redirectTo 而不是 navigateTo：支付页不该留在返回栈里
        // （@see onViewOrders 同一条理由；订单已建好，这一页的历史使命结束）。
        // ⚠️ 参数名是 `id` 不是 `orderId`（R-03 / AJ-225）：订单详情页读的是 `options.id`
        //    （订单列表也传 `?id=`）。这里曾写成 `?orderId=`——付款成功后落地页显示
        //    "订单不存在或链接无效"。参数名现在由 `miniprogram/nav-param-guard.unit.test.ts` 逐处核对。
        // ⚠️ `justPaid=1`（MP3-04，P1）：微信支付在这里就算成功了，但服务端的
        //    `payments` 行可能还没被回调推进——订单详情若照常规口径给「取消订单」，
        //    用户会以为刚才没付上而点它。带上这个标记，详情页在确认前不给出取消与继续支付。
        //    （参数名由 `nav-param-guard` 核对：详情页 `onLoad` 必须真的读它。）
        success: () =>
          wxApi.redirectTo({
            url: `${ORDER_DETAIL_PAGE}?id=${encodeURIComponent(this.orderId)}&justPaid=1`,
          }),
        // @see @limitation 三：取消与失败一视同仁。⚠️ 但不走 errorMessage——
        // 宿主 fail 的形状是 {errMsg}，读出来是 "requestPayment:fail cancel" 这种黑盒文案，
        // 把"用户主动取消"显示成"加载失败"会让人以为付款出了故障。
        // ⚠️ 写进 `payResult` 而不是 `error`（MP3-07）：`error` 会被 `load()` 开头清掉，
        //    而拉起微信收银台会让平台触发 onHide → onShow → reload，
        //    于是"支付未完成，可重新选择支付方式"在用户看到之前就被抹掉了。
        fail: () => this.setData({ payResult: PAY_FAIL_TEXT }),
      });
      return;
    }
    if (plan.kind === 'copylink') {
      // 记下"这张单在浏览器里发起过付款"（W-02）：切回来时支付通知往往还没到，
      // 支付页与订单详情据此显示"确认中"，而不是照常给出"继续支付 / 取消订单"。
      app.globalData.externalPay = markExternalPay(
        app.globalData.externalPay,
        this.orderId,
        Date.now(),
      );
      // ⚠️ 不自动复制：剪贴板是用户的东西，未经动作就改写它是越界。用户点"复制链接"再复制。
      // ⚠️ `copied` 必须复位（AJ-227）：服务端每次发起都**轮换**短链 token，
      //    这是一条新链接；按钮若还写着"已复制"，用户会去浏览器粘贴刚失效的那条。
      this.setData(afterIntent(plan));
      return;
    }
    // auto / unsupported：不该留着上一次的短链与"已复制"（与 copylink 同一条口径）
    this.setData(afterIntent(plan));
    // ⚠️ auto = 响应到达时订单已 paid（MP3-06）：留下来会同时显示"支付已完成"和还能点的通道，
    //    那是自相矛盾的界面。与微信支付成功同口径——离开这一页，让详情页用服务端数据说话。
    if (leavesAfterAuto(plan)) {
      wxApi.redirectTo({ url: `${ORDER_DETAIL_PAGE}?id=${encodeURIComponent(this.orderId)}` });
    }
  },

  /**
   * 复制短链到剪贴板（D-49：银行卡唯一入口 = 短链 → Stripe Checkout 托管页）。
   *
   * @why **必须传 success / fail**（B34 / AJ-217）：`setClipboardData` 是隐私接口，
   *      用户拒绝隐私弹窗或隐私指引漏声明剪切板时会失败；此前不传回调的表现是
   *      "点了没反应"，而这一屏在微信支付上线前是**唯一的付款路径**——
   *      用户唯一的结论是"付不了款"。失败时给出兜底动作（长按链接），
   *      链接文本本身也在页面上（`user-select`，见 index.wxml）。
   * @limitation 失败文案由 `copyResult` 产出（约束十一：文案不在薄壳里写死）。
   */
  /** 错误态 / 无通道空态的"重试"（剩余清单 4-8）：重新取订单与通道。 */
  onRetry() {
    void this.load();
  },

  onCopy() {
    if (this.data.payUrl === '') return;
    wxApi.setClipboardData({
      data: this.data.payUrl,
      success: () => this.setData(copyResult(true)),
      fail: () => this.setData(copyResult(false, app.globalData.privacy)),
    });
  },

  /**
   * 没付成（expired / cancelled）时去首页重新下单（MP3-01）。
   * @why 那句"如需购买请重新下单"必须配一个能点的地方——只说不做等于把用户丢在死胡同：
   *      这一屏是支付流程的终点，下面只有一个"查看订单"，而他要的是**买**，不是看。
   * @why 只对这两态出现：已付款 / 已退款的单给"重新下单"是把人往无关页面上引
   *      （@see closedTextFor）。
   */
  onGoHome() {
    // ⚠️ 用 switchTab 而不是 redirectTo：首页是 **tabBar 页**，而 redirectTo 与 navigateTo
    //    都跳不了 tabBar 页——宿主直接拒绝（"点了没反应"，MP-02 / AJ-366）。
    //    @see ../../utils/wx-api.js @limitation 十三（tab 页只能 switchTab）；
    //         ../../tab-nav-guard.unit.test.ts（这条由机器逐处核对）
    wxApi.switchTab({ url: HOME_PAGE });
  },

  /**
   * 去订单列表（copylink 场景的"支付完成后回到这里查看订单"）。
   * @why 用 `redirectTo` 而不是 `navigateTo`：支付页不该留在返回栈里——
   *      从订单列表按返回键又回到"请在浏览器完成支付"那一屏是明显的死循环感，
   *      而订单已经建好了，支付页的历史使命结束。
   */
  onViewOrders() {
    // ⚠️ 同上：订单列表也是 tabBar 页，必须 switchTab。
    //    这一处尤其要紧——copylink 场景里"支付完成后回到这里查看订单"是用户**唯一的退路**，
    //    它被宿主拒绝的表现是"点了没反应"，而那时他已经在浏览器里付完钱了（MP-02 / AJ-366）。
    wxApi.switchTab({ url: ORDER_PAGE });
  },
});
