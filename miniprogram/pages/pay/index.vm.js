/**
 * 职责：支付页（`pages/pay`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 这一页的坏法全是"点了之后看起来成功了"：连点发起两次、换通道却沿用旧幂等键
 *      （拿到上一个通道的支付凭据）。这两条都不会报错，只会静默多一次请求或付错入口。
 *      所以把"点一下该做什么"收成一个纯函数，让它可以被单测逐分支钉住。
 *
 * @why **不含**通道渲染与"下一步做什么"：那些住在 `utils/pay-plan.js`——
 *      确认页要预取、支付页要执行，两边共用同一份才不会出现"确认页说支持、支付页不显示"。
 *
 * @see ../../utils/pay-plan.js（通道渲染 / 实扣金额 / 下一步）；
 *      ../../utils/idempotency.js（幂等键生命周期）；
 *      ../../utils/order-status.js（PAYABLE：可付状态的唯一真源）；
 *      ../../../server/src/app/pay-intent.ts（服务端对同一件事的护栏）
 */
import { STATUS_LABELS, canPay, statusText } from '../../utils/order-status.js';
import { copyFailText } from '../../utils/privacy.js';
import { channelCountryOf, payGuide } from '../../utils/pay-plan.js';
import { countdownText } from '../../utils/countdown.js';

/**
 * `requestPayment` 的**取消与失败**统一文案（B35 / AJ-218）。
 *
 * @why 以前把宿主 `fail` 直接喂给 `errorMessage`，于是"用户主动取消"显示成"加载失败"——
 *      用户会以为**这次付款出了故障**，而订单其实还好端端地在 pending_payment。
 *      更糟的解读是"钱扣了但没成"，于是再点一次（服务端有幂等键，不会重复扣，
 *      但用户那一分钟的恐慌是真的）。
 * @why 统一成一句**带下一步**的话："支付未完成，可重新选择支付方式"——
 *      它同时覆盖了取消与失败，且不给出"成功还是没成功"的判断
 *      （真值在订单详情里，靠服务端回调；本页不做结论，@see ../pay/index.js @limitation 一）。
 * @limitation 不解析宿主文案去区分"取消 vs 失败"：
 *              `fail` 的 `errMsg` 是黑盒（含 "cancel"），把它当契约等于把自己的正确性
 *              押在微信不改一个字上。@see utils/wx-api.js @limitation 十（同一条口径）
 */
export const PAY_FAIL_TEXT = '支付未完成，可重新选择支付方式';

/** 状态读不到 / 认不出时的说明（P2-41：白名单之外不列支付方式，但要给去处）。 */
export const UNKNOWN_STATUS_TEXT = '订单状态暂时无法确认，请到「我的订单」查看最新状态';

/**
 * 倒计时到点后的关闭屏文案（P2-35）。
 * @why 说"未完成付款"而不是"已关闭"：到点那一刻服务端可能还没关单（作业每分钟一轮），
 *      但对用户来说结论已经确定——这一单付不了了，要买就重新下单。
 */
export const EXPIRED_CLOSED_TEXT = '支付时间已到，该订单未完成付款，将自动关闭；如需购买请重新下单';

/**
 * 通道查询用的目的国（P2-39）：取订单收货地址的 `country`。
 * @param {unknown} order `GET /orders/{id}` 响应（契约 Order.address: Address）
 * @returns {string} 两位大写国家码；缺失 / 形状不对 → `ADDRESS_COUNTRY_DEFAULT`
 * @why 原来写死默认国家：接第二个国家那天，支付页会按美国去过滤加拿大订单的通道（约束四：不写死国家）。
 * @why 只收 `^[A-Z]{2}$`：它要拼进查询串，脏值（`U&`）会改写查询参数。
 */
export function channelCountry(order) {
  // M-16（AJ-406）：判定下沉到 utils/pay-plan.js（结算页预告扣款币种也要按同一个国家查通道）
  return channelCountryOf(order?.address);
}

/**
 * 发起支付被拒后要不要**重查订单**（P2-40）。
 * @param {unknown} code `ApiError.code`
 * @returns {boolean}
 * @why 40902（状态不允许）/ 40904（已过期）的登记表 action 是"刷新订单 / 重新下单"：
 *      多半是这张单已经付了（浏览器那边）或已经关了。只显示一句错误、按钮还在，用户会一直点。
 *      重查后由 `payPageView` 决定换不换关闭屏；仍可付就只留那句错误。
 */
export function recheckAfterPayError(code) {
  return code === 40902 || code === 40904;
}

/**
 * 这一张单**还能不能走支付流程**（B35 / AJ-218）。
 *
 * @param {unknown} order `GET /orders/{id}` 响应（读 `status`）；可能是任何东西
 * @returns {{payable: boolean, closedText: string, goHome: boolean}}
 *   `goHome` 为真时薄壳给一个"回首页"的出口（仅 expired / cancelled，@see closedTextFor）
 *   `payable=false` 时薄壳不列通道，`closedText` 是给用户的说明（空串 = 不渲染）
 *
 * @why 以前支付页**完全不看订单状态**，从返回栈回到一张已付/已关的单，
 *      照样列出支付方式——点下去是 40902。那是个"看起来能用、实际是坏的"按钮，
 *      而用户在支付这个动作上遇到它，第一反应是"是不是刚才没付成功"。
 * @why **白名单**（P2-41，2026-10-07 改）：只有 created / pending_payment 可付，读不到 / 认不出一律**不可付**，
 *      并明说"状态无法确认"（`UNKNOWN_STATUS_TEXT`）。原来按"可付"放行，理由是"读不到不等于不能付"——
 *      但服务端新增一个状态时，前端会对一张根本不该付的单列出支付方式，那是钱的方向上的错；
 *      而"不可付 + 说清去哪看"并不静默：用户有明确的下一步（我的订单），不会卡死。
 * @why `nowMs`（P2-35）：待付款但已过 `expires_at` 的单同样不可付——服务端关单作业每分钟一轮，
 *      到点后的那几十秒里订单仍是 pending，此时付款会落成迟到款（走人工退款）。
 *      判定口径与 `countdownText` 同一处（含等号，KD-7）。不传 nowMs = 不按时间判。
 * @limitation 这是前端的**预判断**，不是权威：服务端状态机仍是唯一裁决
 *              （@see 本函数不改任何写路径）。
 */
/**
 * 「不需要再付钱」与「根本没付成」是**两件相反的事**，原来的文案把两者合成了一句
 * （第三轮审查 MP3-01）。
 *
 * @why 后果不对等：银行卡是当前的**唯一**付款路径，用户在浏览器里被 3DS 或输错卡号耽搁、
 *      超过 30 分钟再切回微信，看到的是"已超时关闭，无需再支付"——
 *      很大一部分人会把这句读成"已经付好了"，然后去等一张永远不会发货的单。
 *      这一屏是微信支付上线前必经的一屏，写错等于白丢一批订单。
 * @why 只改**展示**不改状态口径：状态的真值仍在服务端（@see 本文件 @limitation）。
 */
function closedTextFor(status, latePaid) {
  const label = statusText(status);
  // 退款类：钱的问题还没落定，只报状态，不引导任何动作
  if (status === 'refunding' || status === 'refunded') return `该订单${label}`;
  // 没付成类：必须说清"没付成"，并给出口（重新下单）
  if (status === 'expired' || status === 'cancelled') {
    // P2-11（AJ-386）：关单后才到的付款——钱**已经扣了**。说"未完成付款，请重新下单"会让人再付一次。
    if (latePaid) return `该订单${label}，但我们已收到你的付款，款项会原路退回，无需重新付款`;
    return `该订单${label}，未完成付款；如需购买请重新下单`;
  }
  // 其余（paid / shipped / delivered / completed）：钱已经付了，这句才成立
  return `该订单${label}，无需再支付`;
}

export function payPageView(order, nowMs) {
  const o = order !== null && typeof order === 'object' ? order : {};
  const status = typeof o.status === 'string' ? o.status : '';
  const known = typeof STATUS_LABELS[status] === 'string';
  if (!known) return { payable: false, closedText: UNKNOWN_STATUS_TEXT, goHome: false };
  const payable = canPay(status);
  if (payable) {
    // P2-35：到点即收起（服务端关单有延迟，这段时间付款只会变成迟到款）
    if (Number.isFinite(nowMs) && countdownText(o.expires_at, nowMs).expired) {
      return { payable: false, closedText: EXPIRED_CLOSED_TEXT, goHome: true };
    }
    return { payable, closedText: '', goHome: false };
  }
  return {
    payable,
    closedText: closedTextFor(status, o.late_paid === true),
    // 只有"没付成"才给回首页的出口——已付款的单给它是把人往无关页面上引
    goHome: status === 'expired' || status === 'cancelled',
  };
}

/**
 * 从后台 / 浏览器 / 上一页回到支付页时该做什么（B35 / AJ-218 → AJ-227 改写）。
 *
 * @param {{payUrl?: unknown, guideTitle?: unknown, paying?: unknown,
 *          loading?: unknown}|null|undefined} args
 *   `loading` 上一次整页重取是否还在途中（MP3-07）
 * @returns {'none'|'reload'|'status'}
 *   - `none`：什么都不做；
 *   - `reload`：整页重取（订单 + 支付方式）；
 *   - `status`：**只查订单状态**——已不可付就收起支付方式与短链，仍可付则一个字都不动。
 *
 * @why 支付完成的真值在**服务端回调**里，本页不轮询（@see ../pay/index.js @limitation 一），
 *      所以"用户去浏览器付完款再回来"这一刻，只有再问一次服务端才能把"已付款"显示出来。
 * @why copylink 屏 / 引导屏给 `status` 而不是 `none`（AJ-227）：原来这两屏一律不刷新，
 *      理由是"刷掉短链等于把人回家的路拆了"——理由没错，但**去浏览器付款只发生在 copylink 屏**，
 *      于是 B35 要修的那件事（付完回来还挂着支付方式，点了 40902）恰好没覆盖到银行卡这条主路径。
 *      `status` 两头都守住：没付完 ⇒ 短链原样在；付完了 ⇒ 收起来，别让人再付一次。
 * @why `paying === true` 仍是 `none`：发起支付在途中，再取一次会并发两个"发起"。
 * @limitation 只做判断，**不发起请求**：薄壳按返回值调 `load()` / `checkStatus()`。
 */
export function onShowAction(args) {
  const a = args !== null && typeof args === 'object' ? args : {};
  if (a.paying === true) return 'none';
  // ⚠️ 重取在途（MP3-07）：再排一次不会更快，只会让两个 load 的结果互相覆盖
  //    （旧的那个后到就把支付方式盖回"该订单已付款"旁边）。
  if (a.loading === true) return 'none';
  if (typeof a.payUrl === 'string' && a.payUrl !== '') return 'status';
  if (typeof a.guideTitle === 'string' && a.guideTitle !== '') return 'status';
  return 'reload';
}

/** 没有引导内容时的 `guide`（与页面 data 的初值同形；wxml 靠 `guide.title` 为空来隐藏那一卡）。 */
export const EMPTY_GUIDE = Object.freeze({ title: '', body: '', actionText: '', steps: [] });

/**
 * 订单已不需要再支付时，支付页要 `setData` 的全部内容（AJ-227 → MP3-01 改签名）。
 * @param {unknown} view `payPageView(order)` 的返回值（不信任它的形状）
 * @returns {{closedText: string, goHome: boolean, channels: never[], notice: never[],
 *            payUrl: string, guide: object, copied: boolean, countdown: string, payResult: string}}
 * @why 收进一个函数：要同时清掉的有五样（支付方式、提示条、短链、引导、"已复制"），
 *      漏清任何一样，页面上就会同时出现"无需再支付"和一个还能点的入口。
 * @why 改成**整个 view 传进来**（原来是只传 `closedText` 字符串）：
 *      文案与"要不要给回首页出口"是同一次判断的两个产物，分两处传就会出现
 *      "说了请重新下单、却没有去下单的路"（MP3-01 修的正是这类半截子结局）。
 * @limitation 只产出"页面该显示什么"，**不做跳转**：宿主调用在薄壳里。
 */
export function closedScreen(view) {
  const v = view !== null && typeof view === 'object' ? view : {};
  return {
    closedText: typeof v.closedText === 'string' ? v.closedText : '',
    goHome: v.goHome === true,
    channels: [],
    notice: [],
    payUrl: '',
    guide: { ...EMPTY_GUIDE },
    copied: false,
    // 扫描 W-02 / W-03：倒计时与上一次支付结果同样作废——"已付款"旁边不能挂着"请在 12:34 内完成支付"或"支付未完成"
    countdown: '',
    payResult: '',
  };
}

/**
 * 复制短链**之后**页面该变成什么样（B34 / AJ-217）。
 *
 * @param {unknown} ok 宿主 `setClipboardData` 的 success 是否触发；任何非 `true` 都当失败
 * @param {unknown} [privacy] `app.globalData.privacy`（utils/privacy.js 的启动授权结果，剩余清单 4-3）
 * @returns {{copied: boolean, error: string, errorRef: string}} 直接喂给 `setData` 的形状
 *
 * @why 支付页这一屏是**微信支付上线前唯一的付款路径**（D-49：银行卡 = 短链 →
 *      Stripe 托管页），而 `setClipboardData` 是**隐私接口**——它可能失败：
 *      用户拒绝官方隐私弹窗（errno 104）、或隐私指引里漏声明了剪切板（errno 112，
 *      对所有用户都失败）。此前这一页只调 `setClipboardData` 且**不传回调**，
 *      失败时页面毫无反应、也不展示链接文本——用户看到的是"这个按钮坏了"，
 *      而法务页与订单详情页早就有同一套兜底，唯独最要紧的这一屏没有。
 * @why 失败文案必须写**兜底动作**（"长按下方链接手动复制"），而不只是"复制失败"：
 *      只说失败等于告诉用户"走投无路"，而链接文本就在屏幕上、长按可选。
 *      这与 `pages/legal/index.js` @limitation 二是同一条口径。
 * @limitation 只产出"页面该显示什么"，**不碰剪贴板**：宿主调用在薄壳里。
 *              @see ./index.js（onCopy 传 success / fail）
 */
export function copyResult(ok, privacy = undefined) {
  // errorRef 一并清（扫描 W-05）：复制成败与之前的请求错误无关，挂着旧链路号会把客服引向错的日志
  if (ok === true) return { copied: true, error: '', errorRef: '' };
  // 剩余清单 4-3：启动时拒绝过隐私授权 → 说清是被微信拦下的（否则用户以为按钮坏了）
  return {
    copied: false,
    error: copyFailText(privacy, '复制失败，请长按下方链接手动复制'),
    errorRef: '',
  };
}

/**
 * 拿到支付意图**之后**这一屏该变成什么样（MP3-03）。
 *
 * @param {unknown} plan `payPlan(intent)` 的输出（判别联合；这里不信任它的形状）
 * @returns {{payUrl: string, guide: {title: string, body: string, actionText: string}, copied: boolean}}
 *   直接喂给 `setData` 的形状
 *
 * @why 三个分支**都必须显式给出** `payUrl` / `guide` / `copied`：
 *      原先只有 copylink 分支设它们、auto 与 unsupported 清它们，**in_app 分支什么都不做**——
 *      于是"先点银行卡拿到短链、再改点微信支付"之后，屏幕上仍挂着那条短链和「复制链接」，
 *      而服务端换通道时已经把那个银行卡支付行作废了（`server/src/app/pay-intent.ts`）。
 *      用户复制它去浏览器，落地是失效页；更糟的是他早先在浏览器打开过的托管页仍可付款，
 *      于是两处各付一次，其中一笔变迟到款进人工退款。
 * @why `copied` 一律复位：服务端每次发起都**轮换**短链 token，这是一条新链接；
 *      "已复制"若挂着，用户会去粘贴刚失效的那条（AJ-227 同一条理由，这里扩到所有分支）。
 * @limitation 只产出"这一屏显示什么"，**不发起支付、不跳转**：`requestPayment` / `redirectTo` 在薄壳里。
 */
export function afterIntent(plan) {
  const p = plan !== null && typeof plan === 'object' ? plan : {};
  // 只有 copylink 才该有短链：其余任何分支留着上一次的短链，都是一条已经作废的链接
  const payUrl = p.kind === 'copylink' && typeof p.url === 'string' ? p.url : '';
  return { payUrl, guide: payGuide(p), copied: false };
}

/**
 * `auto`（审核期 mock 通道，响应到达时订单已 paid）之后要不要**离开这一页**（MP3-06）。
 * @param {unknown} plan `payPlan(intent)` 的输出
 * @returns {boolean} 真 = 薄壳 `redirectTo` 订单详情
 *
 * @why 原先 auto 只设 guide、不收起通道，于是一屏同时写着"支付已完成"和
 *      "支付前请确认…将以日元扣款 / 30 分钟内未支付将自动关闭"，通道按钮**还能点**。
 *      审核员看到的是自相矛盾的界面，容易被当成"功能不完整"驳回。
 * @why 与 `in_app` 的 success 同口径（"订单已付了就不该再留在支付页"）：
 *      契约写明 auto=true 时响应返回的那一刻订单已经是 paid，
 *      所以 in_app 那条"成功后离开这一页"的理由对 auto 同样成立。
 * @why 不留在这一屏改文案：留下来就得靠前端自己判断"已付"，
 *      而支付完成的真值在服务端（`pages/pay` 不轮询，@see ./index.js @limitation 一）；
 *      去详情页是让**服务端数据**说话，不是让前端替它下结论。
 */
export function leavesAfterAuto(plan) {
  return plan !== null && typeof plan === 'object' && plan.kind === 'auto';
}

/**
 * 点"用这个方式支付"之后的决定。
 *
 * @param {{paying: boolean, channel: unknown, lastChannel: string, hasKey: boolean,
 *          closed?: boolean}|null|undefined} args
 *   传 null / undefined 也算"不该发起"（wxml 传错形态时页面只是不动，不能炸）。
 *   `paying`      上一次发起是否还在途中（B6 / AJ-201 的在途守卫）；
 *   `channel`     wxml `data-channel` 原值（可能是任何东西，不能直接信）；
 *   `lastChannel` 页面记住的上一次通道（空串 = 还没发起过）；
 *   `hasKey`      幂等键生命周期器是否已就绪；
 *   `closed`      页面已是关闭屏（已付 / 已关 / 倒计时到点，P2-35）。
 * @returns {{kind: 'ignore'} | {kind: 'start', channel: string, retireKey: boolean}}
 *
 * @why `paying` 那条守卫（B6 / AJ-201）：上一次发起还没回来就再点，会多打一次
 *      `POST /orders/{id}/pay`。服务端有幂等键兜底（同键不会建第二个会话），
 *      但仍然白占一次连接与一次订单行锁——发起支付这条路要调机构，一次最长 6s，
 *      连接池只有 10 条时"连点"就是自己把自己排队。
 *      ⚠️ 挡的是**浪费**，正确性仍由服务端负责：本函数不做任何重试判断。
 * @why `retireKey`（换通道必须作废键）：同键重放会被服务端判成"上一个通道的 intent"，
 *      用户点了 B 却拿到 A 的支付凭据——同键同参才算重放，参数不同就不是。
 * @limitation 只做"要不要发起 / 要不要换键"这两个判断，**不碰宿主 API、不读时间、
 *              不发起请求**：键的 acquire/retire 与 `requestPayment` 全在薄壳里。
 */
export function payStartDecision(args) {
  const a = args && typeof args === 'object' ? args : {};
  const channel = typeof a.channel === 'string' ? a.channel : '';
  if (channel === '') return { kind: 'ignore' };
  // P2-35：关闭屏（含倒计时到点）之后不再发起——按钮消失前的那一下不该打到服务端
  if (a.closed === true) return { kind: 'ignore' };
  if (a.hasKey !== true) return { kind: 'ignore' };
  if (a.paying === true) return { kind: 'ignore' };
  const last = typeof a.lastChannel === 'string' ? a.lastChannel : '';
  return { kind: 'start', channel, retireKey: last !== '' && last !== channel };
}
