/**
 * 职责：小程序入口（F6c 壳 + I2 登录链装配）——持有全局 token、唯一的请求实例、登录重登接线。
 *
 * @why 请求实例只建一个：trace_id 生成、token 注入、埋点出口都挂在它身上，
 *      若每个页面各建一个，就会出现"这个页面的日志没有 trace_id"这类只在一处发生的缺失。
 *
 * @why **登录用第二个请求器**（`authApi`，不挂 token、不配 relogin）：
 *      relogin 本身要发登录请求，若登录请求走同一个请求器，收到 40101 会再次进入
 *      同一个 single-flight 的 Promise——等自己结束，死锁（@see utils/auth-session.js 文件头）。
 *
 * @see docs/地基搭建清单.md F6c（小程序壳）；docs/代码注释规范与日志体系设计.md（trace_id 与用户行为流 C）
 * @limitation 一：token 的本地键在 `ws:` 前缀下（走 `utils/storage.js`），
 *              与本项目早期那版裸 `token` 键**不兼容**——升级后需要重新登录一次。
 *              ⚠️ 刻意**不做自动迁移**：当前没有真实用户（骨架期 token 是手填的），
 *              为一次性重填写迁移代码，换来的是一段没人测过的"读旧写新删旧"逻辑，
 *              而它出错的形态恰好是"把用户的 token 删了"。真上线前若已有用户，再单独立单元做。
 * @limitation 二：启动时**自动登录**（无 token 时后台登一次）；登录失败**不阻塞启动**——
 *              失败只记实时日志，页面发起的首个请求会经 40101 → relogin 再试一次。
 *              理由：登录接口抖动不该让首页白屏（首页浏览不需要登录）；而受保护接口
 *              的 40101 会触发 relogin，等于"启动登录失败"还有一次自动补救。
 * @limitation 三：**没有登录页**：登录是无感的（code 换 token），用户无需任何操作。
 *              「我的」页的"登录态"展示由它落地时消费 globalData.token。
 */
import { createRequester } from './utils/request.js';
import { skewFromHeaders } from './utils/server-clock.js';
import { createUnconfiguredApi } from './utils/unconfigured-api.js';
import { createWxApi } from './utils/wx-api.js';
import { ensurePrivacyAuthorized } from './utils/privacy.js';
import { watchUpdate } from './utils/update.js';
import { createStorage } from './utils/storage.js';
import { loginAndStore, loginWithWechat, singleFlight } from './utils/auth-session.js';
import { createCartStore } from './utils/cart-store.js';
import { resolveApiBase } from './config.js';
import { newTraceId } from './utils/trace.js';
import { FLUSH_INTERVAL_MS, beaconHeaders, createBeacon, ensureAnonId } from './utils/beacon.js';
import { createErrorLog } from './utils/client-error.js';

/**
 * token 在本地存储里的键。
 * @why 读写都在本文件的相邻两处，仍然抽成常量：键名漂移是"改了写、没改读"这类错误的典型形态，
 *      而它不报错——表现为"每次重登都成功，但一进 App 又是未登录"。
 */
const TOKEN_KEY = 'token';

/**
 * 前端报错 → 实时日志（AJ-421）。模块级创建：`onError` 可能早于 `onLaunch` 里的装配完成就触发。
 * 日志器每次现取（`createWxApi` 是无状态转发，不在模块加载时碰宿主）。
 */
const errorLog = createErrorLog({ logger: () => createWxApi().getRealtimeLogManager() });

App({
  globalData: {
    token: '',
    /**
     * 启动时的自动登录是否已失败（W-08：「我的」页据此不再一直显示"正在登录…"）。
     * F3（第二轮审计 2026-10-11）：请求层 40101 触发的静默重登失败也记在这里——原先只有启动那一次会记，
     * 之后 token 过期、重登失败时「我的」页仍显示"已登录"，买家找不到"重新登录"。成功写 token 时复位（setToken）。
     */
    loginFailed: false,
    /**
     * 服务端时刻 − 本机时刻（毫秒，MP-8）：每个响应的 `Date` 头更新一次（utils/server-clock.js）。
     * 0 = 还没有响应 / 没校准过；判付款截止的页面用 `serverNowMs(Date.now(), clockSkewMs)`。
     */
    clockSkewMs: 0,
    /**
     * 「我的」页"重新登录"调用的入口（M-17，AJ-406）：`() => Promise<{ok: boolean}>`；
     * null = 不可重试（没配 API 地址时，onLaunch 里不装）。
     */
    retryLogin: null,
    /**
     * 当前环境的 API 根地址——**在 onLaunch 里按宿主的 envVersion 解析后写入**。
     * @why 不在模块顶层算：顶层求值时宿主还没准备好（且在 Node 单测里会直接崩）。
     *      空串在这里只是"尚未解析"的初始值，真正的"没配"由 `launchError` 表达。
     */
    apiBase: '',
    /**
     * 启动期的**致命**配置错误（当前只有一种：目标环境没配 API 地址）；`null` = 一切正常。
     *
     * @why 存消息本身而不是 Error 对象：它是给页面显示用的（`showError` 读 `message`），
     *      而 Error 对象带栈，进 `setData` 会连同帧信息一起序列化到视图层。
     * @why 与"不吞异常"的口径不冲突：异常**没有被吞**——它记进了实时日志（带 envVersion），
     *      并且改由每个请求以 ApiError(-2) 的形式继续表达。
     *      吞掉的定义是"之后再也查不到原因"，这里是"换个地方继续响"。
     */
    launchError: null,
    /**
     * 启动时的隐私授权结果（剩余清单 4-3，utils/privacy.js）：'' 尚未完成 / not_needed / agreed / denied / unsupported。
     * 支付页复制链接失败时据此说清原因。
     */
    privacy: '',
    /** 唯一的请求实例；页面通过 `getApp().globalData.api` 使用。 */
    api: null,
    /** 唯一的本地存储实例（带 `ws:` 前缀）；页面不要用宿主的 `getStorageSync`。 */
    storage: null,
    /** 最近一次链路 ID，用于真机排障时对照服务端日志。 */
    lastTraceId: '',
    /** 唯一的购物车实例（本地状态 + 持久化，PRD §3.1 / D-52）；页面都经它读写。 */
    cart: null,
    /**
     * 地址列表页 → 结算页的**一次性**选中交接（空串 = 没有待消费的选择）。
     * @why 小程序没有"带返回值返回"（无 Intent / onActivityResult），可选的三条路是
     *      eventChannel（要求栈内通信、不可跨多次跳转）、storage（会留残留键）、globalData。
     *      选 globalData，代价是**消费方读走后必须立刻清空**——否则下次进结算页会拿到过期选择。
     * @see ../pages/address/index.js @limitation 二（写入侧）；../pages/checkout/index.js（消费侧）
     */
    pickedAddressId: '',
    /**
     * 支付页 → 订单详情的**一次性**交接（MP-10，第二轮审计 2026-10-11）：`{orderId, justPaid}`；null = 没有。
     * @why 从详情进支付、付完 navigateBack 回原详情（不再 redirectTo 出第二张），navigateBack 带不了参数。
     *      详情页 onShow 只认本单的、读走即清（与 pickedAddressId 同口径）。
     * @see ../pages/pay/index.js leaveToDetail / onViewOrders（写入侧）；../pages/order-detail/index.js adoptPaidReturn（消费侧）
     */
    paidReturn: null,
    /**
     * 地址编辑页 → 地址列表页的**一次性**交接：刚新增成功的地址 id（'' = 没有）。
     * @why 从结算页新增地址后，列表页（选择模式）直接选中它返回结算页，不让小白再点一次「用这个地址」（三端走查 2026-10-10）。
     *      列表页 onShow 读走即清，与 pickedAddressId 同口径。
     * @see ../pages/address-edit/index.js（写入侧）；../pages/address/index.js（消费侧）
     */
    justAddedAddressId: '',
    /**
     * 订单详情 → 售后申请页的**一次性**交接：订单摘要（订单号、第一件商品名、件数、缩略图）；null = 没有。
     * @why 售后页顶部要显示是哪一单（全入口点击测试 2026-10-11），由详情页交过去就不用另发请求。读走即清。
     * @see ../pages/order-detail/index.js onApplyAfterSale（写入侧）；../pages/after-sale/index.js onLoad（消费侧）
     */
    afterSaleBrief: null,
    /**
     * 「订单状态已被改过」→ 订单列表的**一次性**信号（`true` = 回来要重取；读走即清）。
     *
     * @why 体验审查 2026-10-15（P1-2）：订单列表原先 `onShow` 无条件重取，翻到第 3 页点进详情、
     *      返回就回到第 1 页、滚动位置归零。改成"有变化才取"之后，必须有个地方告诉列表"变了"——
     *      否则详情页刚取消的那张单回到列表仍是「待付款」，还能点「继续支付」，这比丢分页严重得多。
     * @why 与 `orderTab` 同口径（一次性、读走即清）：这类交接留在 globalData 里，
     *      代价是消费方必须立刻清空，否则下次进列表会拿到过期的"变了"。
     * @why 只记**布尔**（不记 orderId）：列表要重取的是整个当前页签，按单 id 局部更新
     *      等于把分页 / 去重的口径再实现一遍，而一次重取只有一次请求。
     * @see 写入侧：../pages/order-detail/index.js（取消 / 确认收货）、../pages/after-sale/index.js（提交售后）、
     *      ../pages/pay/index.js（离页，可能已付款）、../pages/checkout/index.js（建单成功，新单已存在）
     * @see 消费侧：../pages/order/index.js onShow
     */
    ordersChanged: false,
    /**
     * 「我的」四个订单入口 → 订单页的**一次性**页签意图（M-10 附，AJ-408；'' = 没有）。
     * @why 订单页是 tab 页，`switchTab` 不能带 query；交接方式与 `pickedAddressId` 同理，订单页 onShow 读走即清空。
     * @see ../pages/user/index.js（写入侧）；../pages/order/index.js（消费侧）
     */
    orderTab: '',
    /**
     * 用户行为埋点（M-21 / AJ-409）：`createBeacon` 的实例；null = 没装（API 地址未配置）。
     * 页面一律经 `utils/beacon.js` 的 `track(app, …)` 调用，不直接碰它。
     */
    beacon: null,
  },

  onLaunch() {
    // ⚠️ 宿主能力**只在这里取一次**，然后往下传：app 是装配层，
    //    它知道"跑在小程序里"这件事，下面的 request / 页面不该再关心。
    const wxApi = createWxApi();

    const log = (fields) => {
      if (fields.trace_id) this.globalData.lastTraceId = fields.trace_id;
      // 请求层的运行事件（api_ok / api_failed …）只进实时日志；用户行为五事件走 /beacon 落库（installBeacon，M-21）
      wxApi.getRealtimeLogManager()?.info?.(fields.event ?? 'api', JSON.stringify(fields));
    };

    // ⚠️ 本地存储一律走 `storage` 封装，**不要用 wxApi.getStorageSync**：
    //    那条路没有 `ws:` 前缀，会与同 appid 内任何第三方 SDK 的同名键互撞，
    //    而且互撞**不报错**（只是数据突然不对）。前缀规则由 `storage.js` 唯一持有。
    // ⚠️ **顺序是有意的**：这三步与"服务地址配没配"毫无关系，必须排在地址解析**之前**。
    //    排在之后时，一次"域名没填"会连坐把 storage / cart / token 一起废掉——
    //    表现为"购物车也是坏的"，把排障方向从 config.js 带偏到存储层。
    const storage = createStorage({ wx: wxApi });
    this.globalData.storage = storage;
    // 购物车必须在 storage 之后建：它一建就读盘（坏数据由它自己降级，不抛）
    this.globalData.cart = createCartStore({ storage });
    this.globalData.token = storage.getString(TOKEN_KEY);

    // 环境切换（B4）：小程序没有构建期环境注入，唯一可靠的判据是宿主的 envVersion。
    // ⚠️ resolveApiBase 会**抛**（域名没配），这里**必须接住**：
    //    不接住的后果是 `onLaunch` 从这一句起中断 ⇒ `globalData.api` 保持 null
    //    ⇒ 页面执行 `app.globalData.api(...)` 抛 TypeError ⇒ **白屏**，
    //    而真正的原因只在实时日志里，用户与审核员什么都看不到。
    //    接住之后交由 `createUnconfiguredApi` 继续表达（@see ../utils/unconfigured-api.js @why）。
    const envVersion = wxApi.getAccountInfoSync()?.miniProgram?.envVersion;
    // P2-33：开发版要区分模拟器与真机（真机上 localhost 没有意义，@see config.js DEVELOP_DEVICE_API_BASE）
    const platform = wxApi.getPlatform();
    let apiBase = '';
    try {
      apiBase = resolveApiBase(envVersion, platform);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.globalData.launchError = reason;
      log({
        event: 'launch',
        result: 'api_base_missing',
        env_version: String(envVersion),
        platform: String(platform),
        err_msg: reason,
      });
    }
    this.globalData.apiBase = apiBase;

    // 剩余清单 4-9：新版本下载好后问用户要不要重启（不支持的宿主静默跳过）
    log({ event: 'update_watch', result: watchUpdate(wxApi) });

    // 剩余清单 4-3：需要隐私授权时主动调起官方弹窗（不等用户在付款时撞上剪贴板）；结果只记录，不阻塞启动
    void ensurePrivacyAuthorized(wxApi).then((r) => {
      this.globalData.privacy = r;
      log({ event: 'privacy_authorize', result: r });
    });

    // 登录专用请求器：不挂 token、不配 relogin（@why 见文件头——同请求器登录会死锁）
    const authApi = createRequester({ wx: wxApi, log });
    /**
     * 登录一跳（wx.login → /auth/wechat/login → token 字符串）；失败原样抛出。
     * ⚠️ 用 `singleFlight` 包一层（P2-34）：启动自动登录与请求层 40101 重登**共用**它，
     *    启动登录在途时撞上 40101 不会再发第二次登录（@see utils/auth-session.js singleFlight）。
     */
    const relogin = singleFlight(() => loginWithWechat({ wx: wxApi, api: authApi, apiBase }));

    const { launchError } = this.globalData;
    this.installBeacon(wxApi, storage, apiBase, launchError, log);
    this.globalData.api =
      launchError === null
        ? createRequester({
            wx: wxApi,
            getToken: () => this.globalData.token,
            // ⚠️ relogin 与 setToken 要**成对**：relogin 拿到的新 token 只有经 setToken 写回，
            //    getToken 才会在重放时返回它（@see utils/request.js @limitation 一）
            setToken: (t) => this.setToken(t),
            // F3：重登失败记下来（「我的」页据此给"重新登录"），错误照抛给页面
            relogin: async () => {
              try {
                return await relogin();
              } catch (e) {
                this.globalData.loginFailed = true;
                throw e;
              }
            },
            log,
            // MP-8：用响应头 Date 校准"判付款截止"的时刻（解析不了就不动，沿用上一次的值）
            onHeaders: (header) => {
              const skew = skewFromHeaders(header, Date.now());
              if (skew !== null) this.globalData.clockSkewMs = skew;
            },
          })
        : createUnconfiguredApi(launchError);

    // 启动时无 token → 后台登一次；失败不阻塞启动（@see @limitation 二）
    // ⚠️ 没配地址时**不做**这一跳：它用的是相对 URL（`/api/v1/...`），必然失败，
    //    而且失败原因会把排障方向引向"登录接口坏了"而不是"域名没填"。
    // M-17（AJ-406）：启动自动登录与「我的」页"重新登录"走同一跳（utils/auth-session.js loginAndStore）
    const loginOnce = (event) =>
      loginAndStore({
        login: relogin,
        setToken: (t) => this.setToken(t),
        onFail: (e) => {
          // 记下失败（W-08）：「我的」页据此不再显示"正在登录…"，并给出"重新登录"按钮
          this.globalData.loginFailed = true;
          log({ event, result: 'failed', err_msg: e?.message ?? String(e) });
        },
      });
    // 没配地址时不给重试入口（同下：相对 URL 必然失败，重试只会把排障方向引偏）
    this.globalData.retryLogin = launchError === null ? () => loginOnce('retry_login') : null;
    if (launchError === null && this.globalData.token === '') {
      void loginOnce('auto_login');
    }
  },

  /**
   * 装埋点（M-21 / AJ-409）：队列在 utils/beacon.js，这里只接"怎么发"与"何时发"。
   * @why 直接用 `wxApi.request` 而**不走** `globalData.api`：后者遇到 40101 会静默重登并重放，
   *      埋点绝不能触发登录；且后者的失败会进页面错误分层，埋点失败不该被任何页面看见。
   *      服务端对 beacon 本就不回 401（鉴权可选），这里也不处理响应——发出去即完事。
   * @why 15 秒链式 setTimeout 冲刷 + 切后台（onHide）全部冲刷：小程序全局白名单只有 setTimeout（见 pay 页 startCountdown）。
   * @limitation 没配 API 地址时不装（相对 URL 必然失败，且会把排障方向引偏，与自动登录同口径）。
   */
  installBeacon(wxApi, storage, apiBase, launchError, log) {
    if (launchError !== null) return;
    const beacon = createBeacon({
      anonId: ensureAnonId(storage),
      now: () => Date.now(),
      send: (payload) =>
        wxApi.request({
          url: `${apiBase}/api/v1/beacon`,
          method: 'POST',
          data: payload,
          header: beaconHeaders(this.globalData.token, newTraceId()),
          timeout: 5000,
          success: () => {},
          fail: () => {},
        }),
      onError: (e) =>
        log({ event: 'beacon', result: 'send_error', err_msg: e?.message ?? String(e) }),
    });
    this.globalData.beacon = beacon;
    const tick = () => {
      beacon.flush();
      setTimeout(tick, FLUSH_INTERVAL_MS);
    };
    setTimeout(tick, FLUSH_INTERVAL_MS);
  },

  /** 未捕获的脚本错误（AJ-421）：微信给的是含调用栈的字符串。 */
  onError(msg) {
    errorLog.record('error', msg);
  },

  /** 未处理的 Promise 拒绝（AJ-421）：`res.reason` 可能是 Error、字符串或任意对象。 */
  onUnhandledRejection(res) {
    errorLog.record('rejection', res?.reason);
  },

  /** 切后台：把埋点队列发完（M-21）。 */
  onHide() {
    this.globalData.beacon?.flushAll();
  },

  /** 写入 token（登录回调与 relogin 调用）。 */
  setToken(token) {
    this.globalData.token = token;
    this.globalData.loginFailed = false;
    // ⚠️ 这里没有注入口（app.js 本身不可测，它是装配层）：storage 写失败会**原样抛出**，
    //    不吞——"token 没存上"若被吞掉，表现是"用户每次都要重新登录"且日志里什么都没有。
    //    `storage.js` 与 `wx-api.js` 都遵守同一口径（见各自的 @limitation：不吞异常）。
    this.globalData.storage.setString(TOKEN_KEY, token);
  },
});
