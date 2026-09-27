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
 *              removeStorageSync / getRealtimeLogManager / navigateTo / login /
 *              navigateBack / showModal / requestPayment / setClipboardData）。
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

/** `wx.login` 的入参（只声明我们读的字段）。 */
export interface WxLoginOption {
  success?: (res: { code: string }) => void;
  fail?: (err: WxRequestFail) => void;
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
   * 微信登录 code（`wx.login`）。
   * @why I2 真实登录链（code → `/auth/wechat/login` → token）的第一步宿主调用。
   *      @see @limitation 五（此前刻意未登记，现在真有消费方才登记）
   * @limitation 七：回调式原样透传（Promise 化在 `utils/auth-session.js`，一处）。
   *              这里不做超时处理——微信侧没有超时回调，超时表现为"什么都不发生"，
   *              上层（登录链）要有自己的防线，不能在这里假装有。
   */
  login(option: WxLoginOption): void;
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
}

/** 宿主（`globalThis.wx`）上我们真正读到的形状——比 `WxApi` 宽松，因为官方签名返回 `unknown`。 */
interface WxHost {
  request(option: WxRequestOption): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  getRealtimeLogManager?: () => RealtimeLogger | undefined;
  navigateTo(option: WxNavigateOption): void;
  login(option: WxLoginOption): void;
  navigateBack(option?: WxNavigateBackOption): void;
  showModal(option: WxShowModalOption): void;
  requestPayment(option: WxRequestPaymentOption): void;
  setClipboardData(option: WxClipboardOption): void;
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
  };
  return { ...real, ...over };
}
