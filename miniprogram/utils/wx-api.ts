/**
 * 职责：小程序宿主能力（`wx.*`）的**唯一入口**（F14 第一单元）。
 *
 * @why 业务代码直接写 `wx.request` / `wx.getStorageSync` 有三个后果：
 *      ① **不可测**：`wx` 是运行时注入的全局，Node 侧一 import 就可能崩，
 *         于是每个用到它的模块都要各自发明一套"怎么绕开"的写法——
 *         本仓库在写这个模块之前已经有三种（`typeof wx !== 'undefined'` 守卫、
 *         "模块顶层不引用只在函数体里用"、测试注入 `deps.request`）。
 *         三种写法意味着"哪种是对的"没有答案。
 *      ② **错误形态不可控**：宿主缺失时崩在 `undefined.request` 这一行，
 *         报错信息指向业务代码，而不是"宿主不存在"。
 *      ③ **没有类型**：`wx.getStorageSync` 返回 `unknown`，每个调用方各写各的断言。
 *      收敛到一个入口后，这三点各有一处答案。
 *
 * @limitation 一：**只声明当前真用到的能力**（request / getStorageSync / setStorageSync /
 *              removeStorageSync / getRealtimeLogManager / navigateTo / switchTab / login /
 *              navigateBack / showModal / requestPayment / setClipboardData / redirectTo /
 *              stopPullDownRefresh；另有全局 getCurrentPages → pageDepth）。
 *              新增一个 wx API 就在这里加一个方法——
 *              不要预先铺满官方 API，铺了就会有人依赖上没被测试过的封装（本项目多次踩过"提前做是猜"）。
 * @limitation 二：`getStorageSync` 的契约是**只取字符串**：读到的不是字符串时一律当"没存过"（返回空串）。
 *              要存对象就先 JSON 序列化——小程序 storage 本身也是这个语义。
 *              这不是限制能力，是让"读出来到底是什么"在类型上就说清楚。
 * @limitation 三：**不吞异常**。storage 写失败、request 失败都原样往上抛：
 *              "token 没存上"若在这里被吞掉，表现是"用户每次都要重新登录"，
 *              而日志里什么都没有——那是最难查的一类问题（看起来像登录逻辑的 bug）。
 * @limitation 四：宿主在**每次调用时**取（`globalThis.wx`），不是 import 时取。
 *              这样本模块可以被 Node 侧单测 import：取不到 wx 只会在真正调用时才响亮失败。
 * @limitation 五：`login` 已随 I2 登录链接入（本条是历史注记：它曾被刻意不登记，
 *              理由是"等真有消费方再登记，不预先铺满官方 API"；`wx.getUserProfile`
 *              等仍未登记——MVP 不需要用户资料，code 换 openid 已够）。
 *
 * @tradeoff 多一层转发换来可注入 + 可类型化 + 一处定义错误形态，
 *           代价是**所有 wx 用法都要先来这里登记**。忘登记的人会直接在业务代码里写 `wx.xxx`——
 *           已由 ESLint 的 `no-restricted-globals` 拦住（不是靠 review 记得）。
 *
 * @see docs/地基搭建清单.md F14；./request.js（第一个调用方）
 */

/** `wx.request` 的成功回调参数（只声明我们读的字段）。 */
export interface WxRequestSuccess {
  statusCode: number;
  data: unknown;
}

/** `wx.request` 的失败回调参数。 */
export interface WxRequestFail {
  errMsg?: string;
}

/** `wx.request` 的入参（**回调式**，与官方一致：不改成 Promise，见 @why）。 */
export interface WxRequestOption {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: unknown;
  header?: Record<string, string>;
  /** 毫秒。不传由宿主决定（官方默认 60000，对支付链路太长，调用方应当显式传）。 */
  timeout?: number;
  success?: (res: WxRequestSuccess) => void;
  fail?: (err: WxRequestFail) => void;
}

/**
 * 实时日志器（`wx.getRealtimeLogManager()` 的返回值）。
 *
 * @why 三个方法都标可选：官方在低版本基础库 / 部分场景下返回的对象方法不全，
 *      标成必填会让"方法不存在"变成运行期 `undefined is not a function`；
 *      标可选则逼调用方写 `?.`（我们在 `request.js` 里就是这么用的）。
 */
export interface RealtimeLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** `wx.navigateTo` 的入参（只声明我们传的字段）。 */
export interface WxNavigateOption {
  /** 以 `/` 开头的**页面内绝对路径**（小程序不支持相对路径跳转）。 */
  url: string;
}

/**
 * `wx.switchTab` 的入参（只声明我们传的字段）。
 *
 * @why S5 引入自定义 tabBar 之后登记：tab 页**只能**用 `switchTab` 跳，
 *      `navigateTo` 到 tabBar 页会被宿主直接拒绝（`fail: navigateTo:fail can not navigate to tabBar page`），
 *      而且**不带任何页面栈变化**——表现是"点了没反应"，日志里只有一行宿主文案。
 * @limitation 与 `WxNavigateOption` **形状相同但刻意不复用**：两者是两种跳转语义
 *      （压栈 vs 切 tab），复用一个类型会让"这里该用哪个"变成看不出来的一件事；
 *      代价是改跳转语义时要显式换类型，而那正是要被评审看见的改动。
 */
export interface WxSwitchTabOption {
  /** 以 `/` 开头的**页面内绝对路径**（必须是 `app.json` 的 `tabBar.list` 里登记过的页面）。 */
  url: string;
}

/** `wx.login` 的入参（只声明我们读的字段）。 */
export interface WxLoginOption {
  success?: (res: { code: string }) => void;
  fail?: (err: WxRequestFail) => void;
}

/** `wx.redirectTo` 的入参（只声明我们传的字段）。 */
export interface WxRedirectOption {
  /** 以 `/` 开头的**页面内绝对路径**（小程序不支持相对路径跳转）。 */
  url: string;
}

/** `wx.navigateBack` 的入参（只声明我们传的字段）。 */
export interface WxNavigateBackOption {
  /** 返回的层数；`1` = 回上一页。不传由宿主决定（官方默认 1）。 */
  delta?: number;
}

/**
 * `wx.requestPayment` 的入参（官方五参数 + 回调；字段名与官方一致，不改名）。
 *
 * @why `package` 是保留字但在**对象属性**里合法，且必须与官方一致——
 *      改名的结果是要在这里维护一张映射表，而映射表错一个键
 *      的表现是"支付调不起来"，报错还指向宿主。
 */
export interface WxRequestPaymentOption {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: string;
  paySign: string;
  success?: () => void;
  fail?: (err: WxRequestFail) => void;
}

/** `wx.setClipboardData` 的入参（只声明我们传的字段）。 */
export interface WxClipboardOption {
  data: string;
  success?: () => void;
  fail?: (err: WxRequestFail) => void;
}

/** `wx.showModal` 的入参（只声明我们传的字段）。 */
export interface WxShowModalOption {
  title?: string;
  content?: string;
  /** 按钮文字，最多四个字符（"取消" / "删除"这类）。 */
  confirmText?: string;
  cancelText?: string;
  success?: (res: { confirm: boolean; cancel: boolean }) => void;
  fail?: (err: WxRequestFail) => void;
}

/** 宿主能力的子集。**新增 wx API 就在这里加一个方法**。 */
export interface WxApi {
  request(option: WxRequestOption): void;
  /** 取字符串值；不存在或非字符串 → 空串。@see @limitation 二 */
  getStorageSync(key: string): string;
  setStorageSync(key: string, value: string): void;
  removeStorageSync(key: string): void;
  getRealtimeLogManager(): RealtimeLogger | undefined;
  /**
   * 保留当前页跳转（页面栈最多十层）。
   * @why I2 首页点商品卡要跳详情，而业务代码写 `wx.navigateTo` 会被 `no-restricted-globals`
   *      拦——那道规则正是为"每个页面各发明一套宿主绕法"而设，所以在这里登记，不在页面里破例。
   * @limitation 六：**只登记不兜底**（不判页面栈层数、不判路径是否注册）。
   *              目标页不存在 / 超过十层栈时由宿主的 `fail` 回调报出来，
   *              这里吞掉它的表现是"点了没反应"——那正是最难查的一类问题。
   *              @see @limitation 三（不吞异常，同一口径）
   */
  navigateTo(option: WxNavigateOption): void;
  /**
   * 切到 tab 页（`wx.switchTab`）——**关掉所有非 tab 页**，且**不能带参数**。
   *
   * @why S5 引入自定义 tabBar 之后登记：tab 页必须用它跳，`navigateTo` 会被宿主拒绝。
   * @limitation 十三：**只登记不兜底**，且**不判"目标是不是 tab 页"**。
   *      判错了的表现由宿主的 `fail` 报出来（文案明确指向 tabBar）；
   *      这里"兜底成 navigateTo"的表现是"能跳过去，但 tabBar 不亮"——
   *      一个看起来更成功、实际更错的降级。
   * @limitation 十四：**不能带 query**（`?a=1` 会被宿主忽略）。
   *      tab 页之间传状态只能走全局（本项目是 `app.globalData` / storage），
   *      这点与 `navigateTo` 完全不同，别把 `navigateTo` 的习惯带过来。
   */
  switchTab(option: WxSwitchTabOption): void;
  /**
   * 微信登录 code（`wx.login`）。
   * @why I2 真实登录链（code → `/auth/wechat/login` → token）的第一步宿主调用。
   *      @see @limitation 五（此前刻意未登记，现在真有消费方才登记）
   * @limitation 七：回调式原样透传（Promise 化在 `utils/auth-session.js`，一处）。
   *              这里不做超时处理——微信侧没有超时回调，超时表现为"什么都不发生"，
   *              上层（登录链）要有自己的防线，不能在这里假装有。
   */
  login(option: WxLoginOption): void;
  /**
   * 关闭当前页并跳转（`wx.redirectTo`，**不留**在返回栈里）。
   * @why 支付完成后去订单列表：用 `navigateTo` 会让支付页留在栈里，
   *      从订单列表按返回键又回到"请在浏览器完成支付"那一屏——明显的死循环感，
   *      而订单已经建好了，支付页的历史使命结束。
   * @limitation 十二：**只登记不兜底**（与 navigateTo 同一条，@see @limitation 六）。
   */
  redirectTo(option: WxRedirectOption): void;
  /**
   * 当前页面栈深度（全局 `getCurrentPages().length`；它不挂在 `wx` 上，但同属宿主能力，一样收在这里便于注入）。
   * @why 统一结论 5.3：同类推荐每点一次压一层，压满后 `navigateTo` **静默失败**——调用方要先知道栈多深，才能改用 redirectTo。
   *      @measured: 模拟器里连点同类推荐，第 9–11 次点击页面不变；官方文档"页面栈最多十层"。
   * @limitation 宿主没有 `getCurrentPages` 时抛错（同 host() 口径：越早炸越好，不返回假数字）。
   */
  pageDepth(): number;
  /**
   * 关闭当前页返回（页面栈出栈）。
   * @why I2 地址编辑页保存成功要回列表——用 `navigateTo` 回列表会**再压一层**，
   *      表现为"地址列表页被叠了两层，返回键要按两次"，且列表页不会重新取数。
   * @limitation 八：**只登记不兜底**（不判栈深）。栈里只有一页时由宿主的 `fail` 报出来，
   *              这里补一个 `navigateTo` 兜底的表现是"回到了一个不该存在的页面"。
   *              @see @limitation 三（不吞异常，同一口径）
   */
  navigateBack(option?: WxNavigateBackOption): void;
  /**
   * 模态确认框（**破坏性操作**的唯一确认手段）。
   * @why 删除地址不可撤销：不做确认的表现是"手滑删了常用地址"，
   *      而没有任何日志能说明它是误操作——那是最难自证的一类投诉。
   * @limitation 九：`showToast` 不在此登记——提示走页面内错误文案（可见、可测、不依赖宿主时序）。
   *              只有"需要用户决策"的才用模态，一条提示不值得为一个 wx API 付覆盖率成本。
   */
  showModal(option: WxShowModalOption): void;
  /**
   * 调起微信支付（`wx.requestPayment`）。
   * @why I2 支付页的 in_app 通道（微信支付跨境机构模式）最后一步宿主调用。
   *      五参数全部来自服务端 `PaymentIntent.payload`，这里**不做任何补全**。
   * @limitation 十：**不判"用户取消"**。`fail` 的 `errMsg` 是宿主文案（含 "cancel"），
   *      在这里解析文案去区分"取消 vs 失败"等于把宿主文案当成契约——
   *      微信改一个字就会判错。取消与失败在**上层**一视同仁：都停在支付页，
   *      由用户点"重新支付"（订单仍是 pending_payment，不会重复扣款）。
   */
  requestPayment(option: WxRequestPaymentOption): void;
  /**
   * 复制文本到剪贴板（`wx.setClipboardData`）。
   * @why D-49 定下的银行卡唯一入口：短链 → Stripe Checkout 托管页。
   *      小程序**内**无法打开它（已废 web-view），所以唯一可行的路径是
   *      "复制链接 → 用户自己去浏览器粘贴"。
   * @limitation 十一：只复制，不代为跳转，也不做"是否已复制"的判断
   *      （`success` 回调在原样转发后由调用方决定）。
   *      替用户跳转的表现是"跳到一个打不开的页面"，比复制更糟。
   */
  setClipboardData(option: WxClipboardOption): void;
  /**
   * 收起下拉刷新动画（`wx.stopPullDownRefresh`）——M-04（AJ-405）订单列表 / 订单详情下拉刷新。
   * @why 页面 json 开了 `enablePullDownRefresh` 后，宿主在用户下拉时调 `onPullDownRefresh` 并显示加载动画，
   *      **不会自己收起**；不调它的表现是顶部一直转圈（尤其是取数失败那条路，最容易漏）。
   * @limitation 十六：只登记不兜底（无参、无回调，官方签名也只有可选回调，我们不读）。
   */
  stopPullDownRefresh(): void;
  /**
   * 当前账号信息（`wx.getAccountInfoSync`）——只用来取 `miniProgram.envVersion`（B4）。
   *
   * @why 小程序**没有**构建期环境注入（`process.env` 在小程序里根本不存在，
   *      打包产物是"一份代码跑三个环境"），唯一可靠的"我现在跑在哪个环境"判据
   *      就是宿主给的 `envVersion`（@measured 官方文档：合法值 develop / trial / release，
   *      `miniProgram.envVersion` 自基础库 2.10.0 起；`getAccountInfoSync` 自 2.2.2 起）。
   *      没有它，切环境只能靠"提审前手改一行常量再重新打包"——而漏改的形态是
   *      **正式版打到了 localhost**，全站请求失败且只在真机上可见（开发工具里是好的）。
   *
   * @limitation 十四：**不做兜底**——宿主没有这个方法（基础库过低）时返回 `undefined`，
   *      由 `config.js` 按 develop 回落。刻意不猜：猜错的形态是"体验版打到了生产库"，
   *      那比"正式版全站失败"严重得多（后者响亮、立刻有人报；前者静默写坏生产数据）。
   */
  getAccountInfoSync(): WxAccountInfo | undefined;
  /**
   * 运行平台（P2-33）：`devtools`（开发者工具）/ `ios` / `android` / `ohos` / `windows` / `mac` …
   *
   * @why 开发版（envVersion=develop）在模拟器与真机预览里都是同一个 envVersion，
   *      而 localhost 只在模拟器里有意义——`config.js` 靠它区分两者。
   * @why 先取 `getDeviceInfo`（新接口），没有再退回 `getSystemInfoSync`（旧接口，官方已标为不推荐）。
   *      依据官方文档（**未在真机实测**，AppID 未下来前无法真机预览）：两者返回值都有 `platform`，
   *      开发者工具里为 `devtools`。
   * @limitation 十五：拿不到 / 形状不对 → `undefined`，由 `config.js` 保持原行为（localhost）。不猜。
   */
  getPlatform(): string | undefined;
  /**
   * 隐私授权查询 / 主动触发（剩余清单 4-3，@see ./privacy.js 的 @measured）。
   * ⚠️ 可选：基础库过低的宿主没有这两个 API——返回 undefined 的方法由 privacy.js 判成 unsupported，
   *    交给微信在调用隐私接口时自行弹窗（同 getAccountInfoSync 的"不猜"口径）。
   */
  getPrivacySetting?: ((option: WxPrivacySettingOption) => void) | undefined;
  requirePrivacyAuthorize?: ((option: WxRequirePrivacyOption) => void) | undefined;
  /** 版本更新管理器（剩余清单 4-9，@see ./update.js）；可选：基础库 < 1.9.90 没有。 */
  getUpdateManager?: (() => WxUpdateManager) | undefined;
}

/**
 * `wx.getAccountInfoSync` 的返回形状——**只声明我们读的那一段**。
 * @why 官方对象还有 appId / version / plugin 等字段，全声明进来等于把宿主类型
 *      当成我们的契约去维护；只声明读到的部分，宿主加字段时这里不用跟着动。
 */
export interface WxAccountInfo {
  miniProgram?: { envVersion?: string };
}

/** `wx.getPrivacySetting` 的入参（剩余清单 4-3；只声明我们读的字段）。 */
export interface WxPrivacySettingOption {
  success?: (res: { needAuthorization?: boolean; privacyContractName?: string }) => void;
  fail?: (err: { errMsg?: string }) => void;
}

/** `wx.requirePrivacyAuthorize` 的入参（剩余清单 4-3）。 */
export interface WxRequirePrivacyOption {
  success?: () => void;
  fail?: (err: { errMsg?: string }) => void;
}

/** `wx.getUpdateManager()` 的返回值（剩余清单 4-9；只声明我们用的方法）。 */
export interface WxUpdateManager {
  onUpdateReady(cb: () => void): void;
  onUpdateFailed(cb: () => void): void;
  applyUpdate(): void;
}

/** 宿主（`globalThis.wx`）上我们真正读到的形状——比 `WxApi` 宽松，因为官方签名返回 `unknown`。 */
interface WxHost {
  request(option: WxRequestOption): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  getRealtimeLogManager?: () => RealtimeLogger | undefined;
  navigateTo(option: WxNavigateOption): void;
  /** ⚠️ 与 `WxApi.switchTab` 一一对应：这里漏登记不会红在业务行，
   *      只会红在 `createWxApi` 里那一行 `host().switchTab(...)`——报错位置离根因一屏远。
   *      （本次 S5 引入 `switchTab` 时正好踩到：`WxApi` 与实现都补了，宿主形状漏了。） */
  switchTab(option: WxSwitchTabOption): void;
  login(option: WxLoginOption): void;
  navigateBack(option?: WxNavigateBackOption): void;
  showModal(option: WxShowModalOption): void;
  requestPayment(option: WxRequestPaymentOption): void;
  setClipboardData(option: WxClipboardOption): void;
  redirectTo(option: WxRedirectOption): void;
  stopPullDownRefresh(): void;
  /** ⚠️ 可选：基础库 < 2.2.2 的宿主没有这个同步 API（@see WxApi.getAccountInfoSync @limitation 十四）。 */
  getAccountInfoSync?: () => WxAccountInfo;
  /** ⚠️ 可选（@see WxApi.getPlatform）：新基础库才有 getDeviceInfo；只读 `platform`。 */
  getDeviceInfo?: () => { platform?: unknown } | undefined;
  getSystemInfoSync?: () => { platform?: unknown } | undefined;
  getPrivacySetting?: (option: WxPrivacySettingOption) => void;
  requirePrivacyAuthorize?: (option: WxRequirePrivacyOption) => void;
  getUpdateManager?: () => WxUpdateManager;
}

/**
 * 取宿主。
 *
 * @why **响亮失败**而不是返回 undefined：宿主不存在只有两种可能——
 *      ① 这段代码跑在 Node 里（测试忘了注入）；② 跑在了非小程序的环境里。
 *      两种都是**编程错误**，越早炸越好。静默返回 undefined 会让崩溃推迟到
 *      `undefined.request(...)`，报错信息指向业务行而不是根因。
 */
function host(): WxHost {
  const w = (globalThis as { wx?: WxHost }).wx;
  if (w === undefined) {
    throw new Error(
      'wx 宿主不存在：wx-api 只能在小程序运行时里调用（测试请 createWxApi({…}) 注入假实现）',
    );
  }
  return w;
}

/**
 * 造一个宿主能力入口。
 *
 * @param over 覆盖项——**测试注入假实现用**；生产不传。
 * @why 用"部分覆盖"而不是"整体替换"：调用方只关心自己要替换的那一个能力，
 *      其余仍走真实宿主。整体替换的后果是"测试里没替换到的能力静默变成 undefined"，
 *      表现为"这个用例能跑，换个用例就 undefined 崩"。
 */
export function createWxApi(over: Partial<WxApi> = {}): WxApi {
  const real: WxApi = {
    request: (option) => {
      host().request(option);
    },
    getStorageSync: (key) => {
      const value = host().getStorageSync(key);
      return typeof value === 'string' ? value : '';
    },
    setStorageSync: (key, value) => {
      host().setStorageSync(key, value);
    },
    removeStorageSync: (key) => {
      host().removeStorageSync(key);
    },
    getRealtimeLogManager: () => host().getRealtimeLogManager?.(),
    navigateTo: (option) => {
      host().navigateTo(option);
    },
    switchTab: (option) => {
      host().switchTab(option);
    },
    login: (option) => {
      host().login(option);
    },
    navigateBack: (option) => {
      host().navigateBack(option);
    },
    showModal: (option) => {
      host().showModal(option);
    },
    requestPayment: (option) => {
      host().requestPayment(option);
    },
    setClipboardData: (option) => {
      host().setClipboardData(option);
    },
    redirectTo: (option) => {
      host().redirectTo(option);
    },
    pageDepth: () => {
      const pages = (globalThis as { getCurrentPages?: () => unknown[] }).getCurrentPages;
      if (typeof pages !== 'function') {
        throw new Error('getCurrentPages 不存在：pageDepth 只能在小程序运行时里调用（测试请注入）');
      }
      return pages().length;
    },
    stopPullDownRefresh: () => {
      host().stopPullDownRefresh();
    },
    getAccountInfoSync: () => host().getAccountInfoSync?.(),
    getPlatform: () => {
      const h = host();
      const info = h.getDeviceInfo?.() ?? h.getSystemInfoSync?.();
      const platform = info?.platform;
      return typeof platform === 'string' ? platform : undefined;
    },
  };
  // 隐私 API 只在宿主真有时才挂（剩余清单 4-3）：没有就是 undefined，由调用方判 unsupported
  const w = (globalThis as { wx?: WxHost }).wx;
  if (typeof w?.getPrivacySetting === 'function') {
    real.getPrivacySetting = (option) => host().getPrivacySetting?.(option);
  }
  if (typeof w?.requirePrivacyAuthorize === 'function') {
    real.requirePrivacyAuthorize = (option) => host().requirePrivacyAuthorize?.(option);
  }
  // 剩余清单 4-9：同上，宿主有才挂
  if (typeof w?.getUpdateManager === 'function') {
    real.getUpdateManager = () => (host().getUpdateManager as () => WxUpdateManager)();
  }
  return { ...real, ...over };
}
