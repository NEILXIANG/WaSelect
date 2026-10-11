/**
 * 职责：确认订单页（`pages/checkout`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 这一页是整条链路里**最容易静默出错**的一页：
 *      ① 拿购物车快照价当合计 → 价格变了没人发现（cart-store @limitation 一）；
 *      ② 建单不带 `expected_total_jpy` → 失去"用户看到的 ≠ 服务端算的"这道防线（40905）；
 *      ③ 提交闸门禁用却不说原因 → 被读成"这站坏了"。
 *      这三条没有一条会报错，只会"看起来成功了"。
 *      （幂等键那条已下沉到 `utils/idempotency.js`：确认页与支付页共用。）
 *
 * @why **不含**支付相关函数：支付方式渲染与"下一步做什么"住在 `utils/pay-plan.js`——
 *      确认页要**预取**通道列表（先让用户看到可以用什么付），支付页要**执行**，
 *      两边共用同一份纯函数，才不会出现"确认页说支持、支付页不显示"。
 *
 * @limitation 一：商品行**刻意不带价格**。价格只信 `POST /orders/quote`，
 *              一旦行里出现价格字段，就会有人拿它算合计（快照价会过期）。
 *
 * @see ../../utils/cart-store.js（本地状态）；../../utils/pay-plan.js（支付部分）；
 *      ../../../contracts/api-contract.yaml（Quote / OrderCreated / POST /orders）
 */
import { isContactEmailShape } from '../../utils/email-shape.js';

/**
 * 商品行（**不带价格**：价格只信 quote，@see @limitation 一）。
 * A6（AJ-416）：带加购时的主图快照——只有文字时，同款不同规格的两件认不出来。图是快照、过期无害（不参与算钱）。
 */
export function itemRows(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => i && typeof i.productId === 'string' && i.productId !== '')
    .map((i) => ({
      productId: i.productId,
      title: typeof i.title === 'string' ? i.title : '',
      qty: Number.isInteger(i.qty) ? i.qty : 1,
      image: typeof i.image === 'string' ? i.image : '',
    }));
}

/**
 * 商品已下架或不存在（报价 / 建单 40401）时的出口（联动走查·跨角色 2026-10-10）。
 * @why 运营在买家结算途中下架了商品：提交得 40401、重报价还是 40401，原先只给「重新加载」、底部说"请返回商品页后重试"——
 *      两条都走不通（商品页也显示已下架）。立即购买就回首页挑别的；从购物车来就回购物车把它删掉。
 * @param {unknown} buyNow 是否"立即购买"进来的
 * @returns {{actionText: string, hint: string, target: 'home'|'cart'}}
 */
export function goneExit(buyNow) {
  return buyNow === true
    ? {
        actionText: '回首页看看其它商品',
        hint: '这件商品已下架，请回首页看看其它商品',
        target: 'home',
      }
    : { actionText: '回购物车调整', hint: '有商品已下架，请回购物车删掉它再结算', target: 'cart' };
}

/**
 * `GET /terms` 响应 → 结算页的条款状态（严格检查 M-1b，AJ-441）。
 * @why 就绪要求**版本 + 可打开的地址**两样都有：此前只看版本号，服务端没配条款地址时 `urls` 整键省略，
 *      结算页照样放行"已阅读并同意"——买家同意的是一份打不开的条款。服务端生产已拒启这种配置（config 规则 9c），
 *      这里是客户端的同口径一道（开发 / staging 没配时也能在页面上看出来）。
 * @why 只看 `urls.zh`：结算页的"查看条款"进的是中文法务页；ja / en 缺失不影响这位买家读条款。
 * @limitation 只看"给了地址"，不看地址打不打得开（那要发请求，vm 不做 IO）。
 * @param {unknown} res
 * @returns {{termsVersion: string, termsFailed: boolean}}
 */
export function termsFromResponse(res) {
  const o = res !== null && typeof res === 'object' ? res : {};
  const version = typeof o.version === 'string' ? o.version : '';
  const urls = o.urls !== null && typeof o.urls === 'object' ? o.urls : {};
  const hasUrl = typeof urls.zh === 'string' && urls.zh.trim() !== '';
  return { termsVersion: version, termsFailed: version === '' || !hasUrl };
}

/**
 * 能否提交（按钮禁用 + 原因）。
 * @param {{itemCount: number, addressId: string, termsAccepted: boolean, totalJpy: number|null,
 *          emailError?: string, contactEmail?: string, splitRequired?: boolean,
 *          termsReady?: boolean, termsFailed?: boolean, quoteFailed?: boolean, buyNow?: boolean,
 *          productGone?: boolean, quoteErrorCode?: number, addressFailed?: boolean}} state
 * @why `quoteErrorCode`（F4，第二轮审计 2026-10-11）：停售（40916）/ 账号受限（40301）的报价失败，原先也说"返回购物车检查商品后重试"——
 *      两种都不是购物车的问题、重试也不会好。`addressFailed`（F5）：地址列表没取到时说"请选择收货地址"，
 *      买家会以为自己的地址丢了、去重新填一遍。
 * @why `termsReady` / `termsFailed` / `quoteFailed` 三项（AJ-228）：
 *      条款版本没取到时 `orderBody` 会抛一句**给开发者看的**报错，此前闸门不看它，
 *      于是那句话被原样摆到用户面前；报价**失败**与报价**还没回来**此前是同一句"还在计算中"，
 *      前者永远等不到结果，用户没有出路。三项都是"传了才生效"：不传等于不检查（老调用方不受影响）。
 * @returns {{ok: boolean, reason: string}}
 * @why 返回**原因**而不是只给 ok：禁用但不说为什么的按钮会被读成"这站坏了"，
 *      而原因文案必须由逻辑给（wxml 里写死一串 `wx:if` 会让四条判断各漂移一次）。
 */
export function submitGate(state) {
  const s = state && typeof state === 'object' ? state : {};
  if (!Number.isInteger(s.itemCount) || s.itemCount < 1)
    return { ok: false, reason: '购物车是空的' };
  // 商品已下架（40401）排在地址 / 条款之前：买不了的东西，先让人勾条款再告诉他买不了是白折腾；
  // 也不说"报价失败请重试"——重试不会好（联动走查 2026-10-10）
  if (s.productGone === true) return { ok: false, reason: goneExit(s.buyNow).hint };
  if (typeof s.addressId !== 'string' || s.addressId === '') {
    return {
      ok: false,
      reason:
        s.addressFailed === true ? '收货地址没取到，请点上方「重新加载」再试' : '请选择收货地址',
    };
  }
  if (s.termsFailed === true) return { ok: false, reason: '购买条款暂时取不到，请稍后再试' };
  if (s.termsReady === false) return { ok: false, reason: '正在加载购买条款…' };
  if (s.termsAccepted !== true) return { ok: false, reason: '请先阅读并同意购买条款' };
  // 失败排在"计算中"之前：失败了就不会再有结果，说"计算中"是让人白等
  // 立即购买时那件商品不在购物车里（审查 2026-10-09）：说"返回购物车"是一条走不通的路
  if (s.quoteFailed === true) {
    // F4：按码说——停售 / 账号受限不是购物车的问题，也不是重试能解决的
    if (s.quoteErrorCode === 40916) return { ok: false, reason: '店铺暂停接单中，恢复后即可下单' };
    if (s.quoteErrorCode === 40301)
      return { ok: false, reason: '账号已被限制使用，暂时无法下单，如有疑问请联系客服' };
    return {
      ok: false,
      reason:
        s.buyNow === true ? '报价失败，请返回商品页后重试' : '报价失败，请返回购物车检查商品后重试',
    };
  }
  if (!Number.isInteger(s.totalJpy)) return { ok: false, reason: '运费与合计还在计算中' };
  // B38 / AJ-221：`split_hint` 为 true = **已经超过**单笔上限（服务端 `total > maxOrderJpy`），
  // 提交必然 40906。旧实现只把它当一句提示、照样放行——用户点了才知道被拒，
  // 而这个失败还是"看起来像系统问题"的那一类。
  if (s.splitRequired === true) return { ok: false, reason: '已超过单笔上限，请分两单下单' };
  // 邮箱两项排在最后——前面是"能不能下单"，这两项是"填的东西够不够、对不对"。
  // 先说格式错（AJ-180）：填了但不对时说"请填写"是答非所问。
  if (typeof s.emailError === 'string' && s.emailError !== '')
    return { ok: false, reason: s.emailError };
  // M-01（AJ-405 / AJ-402 Q1）：前端必填。"传了才生效"（同 termsReady）：不传 = 不检查，老调用方不受影响。
  if (typeof s.contactEmail === 'string' && s.contactEmail === '')
    return { ok: false, reason: EMAIL_REQUIRED_TEXT };
  return { ok: true, reason: '' };
}

/** 邮箱错误文案（与服务端 `contact_email_shape` 40001 同一件事，给用户看的版本）。M-01 起去掉"（可留空）"。 */
const EMAIL_ERROR = '邮箱格式不正确';

/**
 * 没填邮箱时的原因（M-01，AJ-405）：说清**为什么要填**，而不是只说"必填"。
 * @why 订阅消息未开通（外部阻塞，对标分析 §7），邮件是付款 / 发货 / 退款通知的**唯一**渠道（AJ-369）；
 *      收集时告知的利用目的要与实际一致（APPI）——这句话与输入框占位说明同一用途。
 */
export const EMAIL_REQUIRED_TEXT = '请填写联系邮箱：付款、发货、退款通知都会发到这里，不填将收不到';

/**
 * 结算页"联系邮箱"输入 → 要发的值与错误（PRD §3 确认订单 / D-39；提审前必须，AJ-180）。
 * M-01（AJ-405 / AJ-402 Q1）：**前端必填**——空着给出 EMAIL_REQUIRED_TEXT；契约 `contact_email` 与服务端仍为可选
 * （订阅消息上线后可回调为选填，不用动契约）。
 * ⚠️ AJ-295：此处原写"收货通知邮箱"——通知链路全库无使用方，那是句不成立的承诺；
 *      AJ-369 订单邮件上线后，用途说明才改回"付款、发货、退款通知"。
 * @param {unknown} raw 输入框原值
 * @returns {{value: string, error: string}} value 为空串 = 没有可用的邮箱（此时 error 必非空）
 * @why 口径与服务端入口（order-routes.ts contact_email）**同一判据**：MP-9（AJ-479）起两边都用
 *      `isContactEmailShape`（服务端 shared、这里是镜像，同一张判例表比对）——前端比服务端严，会拒掉服务端能收的地址；
 *      比服务端松，就是"提交后才报错"。原判据只要求有 @、无空白，`a@b` 也放行（邮件是唯一通知渠道，填错 = 失联）。
 * @why 首尾空白先去掉：输入法与粘贴常带空格，这不是用户想表达的内容。
 * @limitation 只在前端拦：绕过小程序直接调 `POST /orders` 仍可不带邮箱（契约可选，刻意不改，见 AJ-405）。
 */
export function contactEmailOf(raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === '') return { value: '', error: EMAIL_REQUIRED_TEXT };
  return isContactEmailShape(v) ? { value: v, error: '' } : { value: '', error: EMAIL_ERROR };
}

/**
 * 输入过程中要不要显示邮箱错误（F7，第二轮审计 2026-10-11）。
 * @why 原先每敲一个字就判一次：输到 `jane@` 就红一句"邮箱格式不正确"，人还没写完就被说错。
 *      改为：**格式错**等失焦再判；已经报过错时才在输入中实时重判——改对了立即消失。
 *      **清空**照旧立即说明为什么要填（M-01）：那是用户主动删掉的，不是"还没写完"。
 * @param {unknown} raw 输入框原值
 * @param {unknown} shown 当前显示着的错误（空串 = 没在显示）
 * @returns {string} 要显示的错误（空串 = 不显示）
 */
export function emailInputError(raw, shown) {
  const { error } = contactEmailOf(raw);
  if (error === EMAIL_REQUIRED_TEXT) return error;
  return typeof shown === 'string' && shown !== '' ? error : '';
}

/**
 * 结算页该用哪个地址（全量审查 A6，2026-09-29）。
 *
 * @param {{picked?: string, current?: string, list?: Array<{id?: string}>, fallback?: string}} args
 *   `picked`  地址页回传的一次性选择（读走即清空）；
 *   `current` 页面当前持有的选择；
 *   `fallback` 两者都用不上时的回落（薄壳传 `defaultAddressId(list)`）；
 *   `list`    `GET /addresses` 的响应（只用来判断某个 id 是否还在列表里）。
 * @returns {string} 选中的地址 id；没有地址时为空串。
 *
 * @why 优先级必须是 **picked > current > fallback** 三段，缺了 `current` 这一段就会
 *      出现 A6 那个缺陷：每次 `onShow` 都会重算地址，而一次性 `picked` 在第一次就被读走清空了，
 *      于是此后每一次返回结算页都回落到默认地址——用户选了非默认地址 B 之后，
 *      **点"查看条款全文"再返回、进地址页没选就返回、或把小程序切到后台再回来**，
 *      地址就静默回到 A，提交后按 A 发货。页面显示的是 A，而用户已经选过一次，
 *      大多不会再核对。跨境改址要走人工，还有重发成本。
 *
 * @why `current` 也要过一遍"仍在列表里"的检查：用户在别处（或另一个标签页）
 *      把当前地址删掉之后，`current` 是一个已经不存在的 id，
 *      继续用它会让 `orderBody` 带一个服务端必然 40400 的 `address_id`。
 *
 * @limitation 只做"选哪个"，**不做默认地址的判定**：默认逻辑（`is_default` / 第一条）
 *              住在 `utils/address-form.js` 的 `defaultAddressId`，由薄壳算好传进 `fallback`。
 *              在这里再写一份就会变成第二份真源（约束九）。
 */
export function resolveAddressId(args) {
  const a = args && typeof args === 'object' ? args : {};
  const list = Array.isArray(a.list) ? a.list : [];
  const inList = (id) => typeof id === 'string' && id !== '' && list.some((x) => x && x.id === id);
  if (inList(a.picked)) return a.picked;
  if (inList(a.current)) return a.current;
  return typeof a.fallback === 'string' ? a.fallback : '';
}

/**
 * 建单失败之后，页面该做什么（B37 / AJ-220）。
 *
 * @param {unknown} code 服务端业务错误码（`ApiError.code`）；可能是任何东西
 * @returns {'none' | 'requote' | 'reload_terms' | 'renew_key' | 'go_orders'}
 *
 * @why 服务端已经把"这个码该怎么处置"写进了错误码登记表
 *      （`packages/shared/src/errors.ts` 每一条的 `action` 字段：
 *      40905「提示刷新确认页」、40401/40901「提示并刷新」、40011「刷新页面重新加载条款后下单」）。
 *      而结算页对**任何一个码**都只做一件事：显示文案、什么都不做。
 *      于是典型死循环是：管理员改了价 → 用户提交得 40905 → 页面仍显示旧合计 →
 *      再点仍带旧的 `expected_total_jpy` → 还是 40905，**只能退出重进**。
 *      条款升级后的 40011 同理（重拉条款、复位勾选才行）。
 *      ⚠️ 这份"处置指令"早就有了，只是没有人执行它——登记表因此是死数据。
 *
 * @why `requote` 必须**连带作废幂等键**：价格变了 = 意图内容变了
 *      （`expected_total_jpy` 进 body）；沿用同一个键会被服务端判成
 *      "同一个键提交了不同内容"（@see errors.ts 里那条 action），
 *      表现是"重报价之后再点，被一个看不懂的码拒掉"。
 *
 * @limitation 只产出**意图**（要不要重报价 / 要不要重拉条款），
 *              不发起请求、不碰宿主：执行在薄壳的 `createOrder` catch 里。
 *              @tradeoff 保留了"哪些码值得自动恢复"这份清单在前端——
 *              它没有下沉到 shared 是因为它是**页面动作**（重报价是结算页才有的事），
 *              不是跨端口径；但每个码必须与 errors.ts 的 `action` 对得上（有测试守）。
 */
export function recoveryFor(code) {
  if (code === 40905 || code === 40901 || code === 40401) return 'requote';
  // P2-40：40912（包裹超重）/ 40906（超单笔上限）——登记表 action 是"提示减少数量或分多单 / 提示拆分订单"。
  // 建单时才撞上说明报价之后购物车或价格变了；重报价后闸门会给出"已超过单笔上限，请分两单下单"
  // 或"报价失败，请返回购物车检查商品"，而不是停在一句错误上、按钮还能再点出同一个码。
  if (code === 40912 || code === 40906) return 'requote';
  if (code === 40011) return 'reload_terms';
  // 40913（在途单已达上限）：错误码登记表的 action 是"引导去订单列表支付或取消已有订单"。
  // 只显示文案的话，用户得自己 回首页 → 我的 → 我的订单 → 逐张进详情取消——
  // 大多数人做不到，结果是放弃这一单（AJ-240 记的"未做"项，此处补上）。
  if (code === 40913) return 'go_orders';
  // 40908（同键不同内容，AJ-228）：登记表的 action 是"为每次新意图生成新的幂等键"。
  // `keyAction` 让它正常情况下不会发生；真发生了就作废键——否则这一页每次再点都是同一个码。
  if (code === 40908) return 'renew_key';
  return 'none';
}

/**
 * 这次提交该沿用幂等键还是换新键（AJ-228）。
 *
 * @param {Partial<{sentBody: string|null, body: string}>|null|undefined} args
 *   `sentBody` = 当前这个键**上一次**带出去的请求体（JSON 文本）；从没发过为 null。
 *   `body` = 这次要发的请求体（JSON 文本）。
 * @returns {'reuse' | 'renew'}
 *
 * @why 入参刻意写成"可选 + 可为 null"而不是先写上具体对象类型：
 *      这里是**调用方可能传脏值**的那一层（超时的老状态、`JSON.stringify` 之前的对象缺失），
 *      而 `await` 之间的状态本来就可能是半个；把它声明成必填，只会让"防御分支"在类型层面无处可测
 *      ——测试的脏输入用例（`null` / `{}`）会编译不过，防御代码反而因此被删。
 *      ⚠️ 用 `Partial<…>` 而不是裸对象字面量联合（`{{…}|null|undefined}`）：
 *      后者 JS 里没有与之对应的语法，TS 的 JSDoc 解析器处理嵌套大括号联合时会把
 *      `?` 与联合都丢掉，得出一个"必填对象"类型——实测正是这 2 条 TS2345 的来源。
 *
 * @why 规则只有一句：**同一个键 ⇔ 同一份请求体**。服务端正是这样判的
 *      （同键同指纹 → 重放首次结果；同键不同指纹 → 40908）。
 *      A5（AJ-190）只在"成功"与"选了新地址"时作废键，漏了其它会改请求体的事：
 *      改邮箱、切后台回来重报价后合计变了、当前地址被删后回落默认。
 *      超时之后只要碰了其中任何一样再点，就是同键不同内容——40908，且这一页再也点不通。
 * @why 比**整份请求体**而不是逐个字段登记"哪些变化要换键"：逐个登记正是漏掉的原因；
 *      请求体就是服务端取指纹的对象，拿它比，永远不会与服务端的判定不一致。
 * @tradeoff 上一次结果未知（超时）而内容又变了时，换键可能建出**第二张未付款的单**
 *      （若上一次其实已建成）。它不会扣两次钱：两张都是待付款，多出来的那张 30 分钟后自动关单并回补库存。
 *      另一个选择是不换键——那就是 40908 死路，用户只能退出重进，而退出重进同样会换键。
 *      两害取其轻：让用户能把单下出去。
 * @limitation 依赖请求体 JSON 的键序稳定：`orderBody` 每次按固定顺序建对象，成立。
 */
export function keyAction(args) {
  const a = args && typeof args === 'object' ? args : {};
  if (typeof a.sentBody !== 'string') return 'reuse';
  return a.sentBody === a.body ? 'reuse' : 'renew';
}

/**
 * 组装 `POST /orders` 请求体。
 * @param {{items: Array, addressId: string, termsVersion: string,
 *          expectedTotalJpy?: number|null, contactEmail?: string}} args
 * @why `terms_version` / `address_id` 缺失**直接抛**而不是发出去：
 *      服务端一律拒单（D-43 条款版本不一致即 40011），
 *      晚失败的表现是"点了提交转一圈然后失败"，早失败至少能指到"没拿到条款版本"。
 * @limitation 二：`expected_total_jpy` **有才带**（quote 还没回来时不带）。
 *              它是防线不是必填项：带 null 会被类型校验拒；
 *              没有合计时这一道防线降级（服务端照算），但不阻塞下单。
 */
export function orderBody(args) {
  const a = args && typeof args === 'object' ? args : {};
  if (typeof a.termsVersion !== 'string' || a.termsVersion === '') {
    throw new Error('orderBody：terms_version 不能为空（GET /terms 没拿到版本就不是提交时机）');
  }
  if (typeof a.addressId !== 'string' || a.addressId === '') {
    throw new Error('orderBody：address_id 不能为空');
  }
  const body = {
    items: itemRows(a.items).map((i) => ({ product_id: i.productId, qty: i.qty })),
    address_id: a.addressId,
    terms_version: a.termsVersion,
  };
  if (Number.isInteger(a.expectedTotalJpy)) body.expected_total_jpy = a.expectedTotalJpy;
  if (typeof a.contactEmail === 'string' && a.contactEmail !== '')
    body.contact_email = a.contactEmail;
  return body;
}

/** 结算模式：立即购买（剩余清单 4-4）。 */
export const BUY_NOW_MODE = 'buynow';

/**
 * 结算的条目来源（剩余清单 4-4）：立即购买只结那一件，否则结购物车。
 * @why 立即购买的单件丢了（小程序进程被回收后 globalData 清空）时返回**空**而不是回落到购物车：
 *      回落的后果是用户点了"立即购买 A"，结算页却是购物车里的 B、C——他未必细看就付了。空态至少是诚实的。
 * @param {{mode?: string, buyNow?: unknown, cartItems?: unknown}} args
 * @returns {Array<{productId: string, qty: number, title?: string, image?: string, selected?: boolean}>}
 */
export function checkoutItems(args) {
  if (args?.mode === BUY_NOW_MODE) {
    const b = args.buyNow;
    return b !== null &&
      typeof b === 'object' &&
      typeof b.productId === 'string' &&
      b.productId !== ''
      ? [b]
      : [];
  }
  // A3（AJ-416）：只结勾选的；缺字段 = 勾选（与 cart-store @limitation 五同口径）
  return Array.isArray(args?.cartItems)
    ? args.cartItems.filter((i) => i && i.selected !== false)
    : [];
}

/** 建单成功后是否从购物车移除买走的那几件（A3 起只移除勾选结算的）：立即购买不动购物车（车里的东西用户没打算现在买）。 */
export function clearsCartAfterOrder(mode) {
  return mode !== BUY_NOW_MODE;
}

/** 能点名到某一件的失败码 → 说法（U9）。 */
const NAMED_ITEM_TEXT = {
  40401: '已下架或不存在，请返回购物车移除后再下单',
  40901: '库存不足，请返回购物车减少数量后再下单',
};
/** 立即购买模式（那件商品不在购物车里，审查 2026-10-09）。 */
const NAMED_ITEM_TEXT_BUY_NOW = {
  40401: '已下架或不存在，暂时不能购买',
  40901: '库存不足，暂时不能购买',
};

/**
 * 报价 / 建单失败时点名是哪一件（U9，三端联动模拟 2026-10-08）。
 * @why 原先结算页只说"商品不存在或已下架"，不说哪一件——购物车里五件时用户只能挨个猜；
 *      服务端在 `data.product_id` 里已经指出了那一件，购物车页早就用它标红了（剩余清单 4-7）。
 * @returns {string} 点名文案；码不认识 / 没带 id / id 不在这次的商品里 → 空串（调用方沿用通用文案，不猜）
 */
export function namedItemError(err, items, opts) {
  const code = err !== null && typeof err === 'object' ? err.code : undefined;
  const id = err !== null && typeof err === 'object' ? err.data?.product_id : undefined;
  const text = (opts?.buyNow === true ? NAMED_ITEM_TEXT_BUY_NOW : NAMED_ITEM_TEXT)[code];
  if (text === undefined || typeof id !== 'string') return '';
  const hit = Array.isArray(items) ? items.find((i) => i?.productId === id) : undefined;
  const title = typeof hit?.title === 'string' && hit.title !== '' ? hit.title : '';
  return title === '' ? '' : `「${title}」${text}`;
}
