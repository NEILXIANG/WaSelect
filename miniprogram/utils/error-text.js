/**
 * 职责：把请求封装抛出的错误变成**用户可读的一行文案**。
 *
 * @why 首页与详情页都要显示错误，而错误形状（`ApiError{code,message}`、网络层负数码、
 *      以及"抛出来的根本不是 Error"）只有一种正确读法。两处各写一遍的结果是
 *      "A 页显示 `50003 汇率缺失`、B 页显示 `undefined`"——用户对后者的解读是"这个站坏了"。
 *
 * @why `code` 保留在文案里：它可机读，真机排障时截图就能对照错误码表，
 *      比"加载失败"四个字值钱得多（@see docs/代码注释规范与日志体系设计.md 流 A）。
 *
 * @limitation 不做重试 / 不做跳转：**行动**是页面的决定（哪些错误值得重试是产品决策，
 *            request.js 的 @limitation 一 写明了为什么不自动重试）。这里只负责"说清楚"。
 *
 * @see ../utils/request.js（错误形状真源：ApiError / NETWORK_ERROR_CODE）
 */

/**
 * @param {unknown} err 请求封装抛出的错误，也可能是任何东西（不要假设形状）
 * @returns {string} `code message` 或 `message` 或兜底文案；永不为空串
 *
 * @why `message` 读不到时兜底读 **`errMsg`**（B35 / AJ-218）：宿主回调（`wx.*` 的
 *      `fail`）给的形状是 `{errMsg}`，不是 `{message}`。以前一律回落到"加载失败"，
 *      于是宿主说 `navigateTo:fail webview count limit exceed` 时页面只显示"加载失败"——
 *      ⚠️ 排障时**唯一**的信息（宿主给的原因）在这一层被扔掉了，
 *      而它恰恰是能被机读、能对照官方文档的那一段。
 *      @limitation 兜底只用于**读不到 message 时**：`ApiError` 有 `message`，
 *                  不会被宿主形状顶掉（顺序固定，不是"谁新谁赢"）。
 */
export function errorMessage(err) {
  const isObj = err !== null && typeof err === 'object';
  // 剩余清单 4-6：网络层失败（负数码）给人话；宿主原始串（request:fail timeout）只进 errorRef 小字
  if (isObj && err.code === GATEWAY_CODE) return GATEWAY_TEXT;
  if (isObj && Number.isInteger(err.code) && err.code < 0 && err.code !== UNCONFIGURED_CODE) {
    return NETWORK_TEXT;
  }
  // P2-40：两个"服务端原文说不清下一步"的码，换成能照着做的话
  if (isObj && err.code === BUSY_CODE) return busyText(err.data);
  // 40301 有**多种成因**（见 isBlocked 的 @why）：只有"账号被拉黑"才说账号被限制，
  // 其余（源站校验失败、角色/受众不符）按服务端故障说，且不撤掉重试（见 contactFields）
  if (isObj && err.code === FORBIDDEN_CODE) return isBlocked(err) ? FORBIDDEN_TEXT : GATEWAY_TEXT;
  if (isObj && err.code === SALES_PAUSED_CODE) return SALES_PAUSED_TEXT;
  if (isObj && err.code === LOGIN_EXPIRED_CODE) return LOGIN_EXPIRED_TEXT;
  const fromMessage = isObj && typeof err.message === 'string' ? err.message.trim() : '';
  const fromErrMsg =
    fromMessage === '' && isObj && typeof err.errMsg === 'string' ? err.errMsg.trim() : '';
  // 体验排查 2026-10-14：服务端 message 一律是中文；没有中文的 message（英文网关页 / 堆栈）买家读不懂，
  //   不如说"加载失败"。宿主 errMsg 保持原样（B35 / AJ-218：那是没有码的宿主失败，吞掉就没线索了）
  if (fromMessage !== '' && !/[\u3400-\u9fff]/.test(fromMessage)) return '加载失败';
  const msg = fromMessage || fromErrMsg;
  return msg === '' ? '加载失败' : msg;
}

/** 网络层失败的人话（剩余清单 4-6）。 */
const NETWORK_TEXT = '网络不太稳定，请检查网络后重试';
/** 有响应无业务码（网关故障，request.js GATEWAY_ERROR_CODE）：问题在服务端，不让用户去查网络（扫描 W-06）。 */
const GATEWAY_CODE = -3;
const GATEWAY_TEXT = '服务暂时不可用，请稍后重试';
/** "服务地址没配"（unconfigured-api，-2）的 message 本身就是给人看的说明，不替换。 */
const UNCONFIGURED_CODE = -2;

/**
 * 上游熔断（50300，P2-40）：服务端在 `data.retry_after_ms` 里给了退避时长（server/src/errors.ts）。
 * @why 原文"服务暂时不可用，请稍后重试"没有"稍后"是多久；用户一般立刻再点，撞上的还是熔断。
 *      有数就说"约 N 秒"（向上取整：说少了用户会提前再点一次），没数或数不合法就不编。
 */
const BUSY_CODE = 50300;
function busyText(data) {
  const ms = data !== null && typeof data === 'object' ? data.retry_after_ms : undefined;
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
    return `服务繁忙，约 ${String(Math.ceil(ms / 1000))} 秒后再试`;
  }
  return '服务繁忙，请稍后再试';
}

/**
 * 40301（P2-40）：服务端这个码**不止一种成因**，其中买家可达的只有两种：
 * - `blocked`（server/src/app/auth.ts:224）——账号被拉黑：用户自己那一侧的事，重试永远不会成功；
 * - `origin_not_verified`（server/src/http.ts:410）——源站校验中间件（只接受经 Cloudflare 的流量）
 *   在请求头上没看到共享密钥。**一次基础设施故障**，与买家账号无关，重试在故障修好后是有效的。
 * 另有 `not_admin` / `admin_totp_required`（管理端）与角色·受众不符（`auth.ts:155,210`，不带 reason），
 * 买家小程序碰不到，但也不该被这边猜成"你被封了"。
 *
 * @why 判据是**白名单**（只有 `blocked` 才算）：把不确定的成因一律说成"账号被限制"，
 *      代价是"CF 头注入坏了"这种线上事故里，**全体买家**读到"账号已被限制使用"、并去找客服——
 *      而客服那边查不出任何问题（用户账号正常）。反过来冤枉成服务故障的代价只是"再点一次"。
 * @limitation `blocked` 这个字符串在服务端是**手写常量**（`auth.ts:224`），两端没共享
 *            （`packages/shared/src/errors.ts` 只管码与 action，不含 reason）。服务端改词而这里不改，
 *            表现是"被拉黑的买家看到服务不可用"——去客服的路没了，需要人工核对（见本轮报告"未共享"项）。
 */
const FORBIDDEN_CODE = 40301;
const FORBIDDEN_TEXT = '账号已被限制使用，如有疑问请联系客服';
/** 40301 里"账号被拉黑"这一种的 reason 值（服务端 auth.ts 的 `{ reason: 'blocked' }`）。 */
const FORBIDDEN_BLOCKED_REASON = 'blocked';

/** 这个 40301 是不是"账号被拉黑"那一类（其余成因按服务端故障说）。 */
function isBlocked(err) {
  const d = err !== null && typeof err === 'object' ? err.data : undefined;
  return d !== null && typeof d === 'object' && d.reason === FORBIDDEN_BLOCKED_REASON;
}

/**
 * 页面共用：这个错误是不是"账号被拉黑"（40301 + `reason === 'blocked'`）。
 *
 * @why 这是**唯一**的判据，页面不要再自己写 `code === 40301`：同一个假设原先在四处各写一份
 *      （`utils/error-text.js`、`pages/checkout/index.vm.js` 两处、`pages/cart/index.vm.js` 两处、
 *      `pages/pay/index.js`），而 40301 的成因不止一种——照码判会把"源站校验失败"（`http.ts`）
 *      也当成"你被封了"，把基础设施故障说成用户自己的问题（规律①：修一处不扫同类）。
 * @param {unknown} err 请求封装抛出的错误
 * @returns {boolean}
 */
export function isAccountBlocked(err) {
  return err !== null && typeof err === 'object' && err.code === FORBIDDEN_CODE && isBlocked(err);
}

/**
 * 40101 到了页面（F3，第二轮审计 2026-10-11）：请求层已经静默重登并重放过一次（utils/request.js @limitation 一），
 * 还是 40101 或重登本身失败，才会抛到这里。
 * @why 服务端原文"未登录或登录已过期"没有下一步；页面的「重试」会再走一次静默重登（失败的重登不会被缓存），
 *      所以照实说"重试会自动重新登录"。重登失败同时记进 globalData.loginFailed，「我的」页给"重新登录"按钮（app.js）。
 */
const LOGIN_EXPIRED_CODE = 40101;
// 不点名按钮（规律排查 2026-10-12）：这句会出现在按钮叫「重新加载」「保存」「提交申请」的各页
const LOGIN_EXPIRED_TEXT = '登录状态已失效，再操作一次会自动重新登录';

/**
 * 40916 全局停售（AJ-384）。
 * @why 三端联动模拟（2026-10-08）：停售中支付页倒计时照走、付款被拦，原文"请稍后再来"让买家一直重试到订单过期。
 *      说清楚：未付款的单到期会自动关，恢复后重新下单即可（没扣钱）。
 */
const SALES_PAUSED_CODE = 40916;
const SALES_PAUSED_TEXT =
  '店铺暂停接单中，暂时无法下单或付款；未付款的订单到期会自动关闭（不扣款），恢复后重新下单即可';

/**
 * 报障小字（剩余清单 4-6 / M9）：`联系客服时请提供：40002 · abcdef12`（网络层再附宿主原因）。
 * @why 三端模拟测试 2026-10-11（用户要求：买家看不懂的信息算缺陷）：原写「错误码 40002 · 链路 abcdef12」，
 *      "链路"是技术词，买家既看不懂、也不知道这串号拿来干什么；直接说用途，号码本身不变（客服照样凭它查日志）。
 * @why 主文案给人看、小字给客服看：用户截图发给客服时，客服凭链路号能在日志里找到这一次请求的全部记录；
 *      而把码与英文原因拼进主文案，用户读到的是一串看不懂的东西。
 * @why 链路号只取前 8 位：够在日志里检索（trace_id 前缀匹配），又不至于一行放不下。
 * @returns {string} 空串 = 没有可报的信息（页面不显示小字）
 */
export function errorRef(err) {
  if (err === null || typeof err !== 'object' || !Number.isInteger(err.code)) return '';
  // 网络层失败（负数码）不显示码本身：-1 / -3 是端内约定，买家看不懂、客服也查不到（三端模拟测试 2026-10-11）
  const parts = err.code < 0 ? [] : [String(err.code)];
  if (typeof err.traceId === 'string' && err.traceId !== '') parts.push(err.traceId.slice(0, 8));
  if (err.code < 0 && typeof err.message === 'string' && err.message.trim() !== '') {
    parts.push(`网络原因：${err.message.trim()}`);
  }
  return parts.length === 0 ? '' : `联系客服时请提供：${parts.join(' · ')}`;
}

/**
 * 错误态的出口该不该是「联系客服」（AJ-433，用户 2026-10-10 授权代决）：`setData({...contactFields(e)})` → `{errorContact}`。
 * @why 只有"账号被拉黑"（40301 且 `reason === 'blocked'`）的出口才是客服：它的重试永远不会成功。
 *      原先按**码**判，于是源站校验失败（同码、不同成因）也被撤掉重试、指向客服——
 *      文案与按钮必须说同一件事，所以这里与 `errorMessage` 用**同一个判断**（`isBlocked`），
 *      不会出现"一个说服务不可用、一个给客服按钮"。
 * @limitation 只给出"该去客服"的布尔；去哪儿（「我的」页的客服卡片）由页面决定。
 */
export function contactFields(err) {
  return {
    errorContact: isAccountBlocked(err),
  };
}

/**
 * 页面一次写入主文案与小字：`setData({...errorFields(e)})` → `{error, errorRef}`。
 * @param {string} [key] 主文案的键名（默认 error；保存错误用 saveError → 同时给 saveErrorRef）
 */
export function errorFields(err, key = 'error') {
  return { [key]: errorMessage(err), [`${key}Ref`]: errorRef(err) };
}
