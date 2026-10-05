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
import { createUnconfiguredApi } from './utils/unconfigured-api.js';
import { createWxApi } from './utils/wx-api.js';
import { createStorage } from './utils/storage.js';
import { loginWithWechat } from './utils/auth-session.js';
import { createCartStore } from './utils/cart-store.js';
import { resolveApiBase } from './config.js';

/**
 * token 在本地存储里的键。
 * @why 读写都在本文件的相邻两处，仍然抽成常量：键名漂移是"改了写、没改读"这类错误的典型形态，
 *      而它不报错——表现为"每次重登都成功，但一进 App 又是未登录"。
 */
const TOKEN_KEY = 'token';

App({
  globalData: {
    token: '',
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
  },

  onLaunch() {
    // ⚠️ 宿主能力**只在这里取一次**，然后往下传：app 是装配层，
    //    它知道"跑在小程序里"这件事，下面的 request / 页面不该再关心。
    const wxApi = createWxApi();

    const log = (fields) => {
      if (fields.trace_id) this.globalData.lastTraceId = fields.trace_id;
      // 当前只用实时日志：ADR-29 的 /beacon 落库上报待 F5 补完
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
    let apiBase = '';
    try {
      apiBase = resolveApiBase(envVersion);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.globalData.launchError = reason;
      log({
        event: 'launch',
        result: 'api_base_missing',
        env_version: String(envVersion),
        err_msg: reason,
      });
    }
    this.globalData.apiBase = apiBase;

    // 登录专用请求器：不挂 token、不配 relogin（@why 见文件头——同请求器登录会死锁）
    const authApi = createRequester({ wx: wxApi, log });
    /** 登录一跳（wx.login → /auth/wechat/login → token 字符串）；失败原样抛出。 */
    const relogin = () => loginWithWechat({ wx: wxApi, api: authApi, apiBase });

    const { launchError } = this.globalData;
    this.globalData.api =
      launchError === null
        ? createRequester({
            wx: wxApi,
            getToken: () => this.globalData.token,
            // ⚠️ relogin 与 setToken 要**成对**：relogin 拿到的新 token 只有经 setToken 写回，
            //    getToken 才会在重放时返回它（@see utils/request.js @limitation 一）
            setToken: (t) => this.setToken(t),
            relogin,
            log,
          })
        : createUnconfiguredApi(launchError);

    // 启动时无 token → 后台登一次；失败不阻塞启动（@see @limitation 二）
    // ⚠️ 没配地址时**不做**这一跳：它用的是相对 URL（`/api/v1/...`），必然失败，
    //    而且失败原因会把排障方向引向"登录接口坏了"而不是"域名没填"。
    if (launchError === null && this.globalData.token === '') {
      void relogin()
        .then((t) => this.setToken(t))
        .catch((e) => {
          log({ event: 'auto_login', result: 'failed', err_msg: e?.message ?? String(e) });
        });
    }
  },

  /** 写入 token（登录回调与 relogin 调用）。 */
  setToken(token) {
    this.globalData.token = token;
    // ⚠️ 这里没有注入口（app.js 本身不可测，它是装配层）：storage 写失败会**原样抛出**，
    //    不吞——"token 没存上"若被吞掉，表现是"用户每次都要重新登录"且日志里什么都没有。
    //    `storage.js` 与 `wx-api.js` 都遵守同一口径（见各自的 @limitation：不吞异常）。
    this.globalData.storage.setString(TOKEN_KEY, token);
  },
});
