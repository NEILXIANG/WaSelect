/**
 * 职责：管理端三个订单操作（发货 / 退款 / 改址）的**准入判定**（I2 U-B2a）。
 *
 * 边界：纯函数——不读库、不取时钟、不抛异常以外的副作用，不 I/O。
 *      判定通过后"怎么做"（事务、调 provider、写事件）在 `app/admin-order-routes.ts`。
 *
 * @why 准入与执行**分开**：准则是纯规则（状态 × 拒付两个维度，共几十种组合），
 *      执行有副作用（出库、退钱、改快照）。混在一起就只能靠真库测试覆盖组合，
 *      而真库测试跑一次 50 秒——规则错了却要等 50 秒才知道，没人会反复跑。
 *      分开后规则用单测（毫秒级）全组合覆盖，执行只测"调没调对"。
 *
 * @why 三个闸门共用 `canTransition`（domain/order.ts 的迁移表）而不是各写一份状态清单：
 *      "哪些状态能发货/退款"本质就是状态机的一条边。另写一份的失败模式是
 *      **状态机改了这里没改**——那时"状态机说能迁、闸门说不能"两边都自圆其说，
 *      而客服只能看到"按钮点不动"，没有任何一方报出冲突。
 *
 * @limitation 一：`shipGuard` 对"有进行中的拒付"是**拦**（40909）。
 *      @tradeoff 选的是**保守方向**（D-69 判据① 选保守方向）：拒付中发货，
 *              争议赢了拿回钱、输了钱货两空；拦下来只是"发货晚一点"。
 *              ⚠️ 代价是**少一条"已发货且有物流轨迹"的证据**——而物流轨迹恰恰是
 *              打赢"未收到货"类拒付的主要证据。所以这条是**可以推翻**的：
 *              若将来拿到拒付原因（`payments` 表目前不存 reason），
 *              应当按原因分流（未授权→不发货；未收到→照发以留证据），
 *              那时只改本函数 + 前端 `shipGate` 的 @limitation 四。
 * @limitation 二：`completed` 能不能退款由**状态机**单独决定（`ORDER_TRANSITIONS.completed = []`），
 *              本模块**不**另写一条"已完成不可退"。原因见上 @why：两处都写就会漂移。
 *              前端 `refundGate` 把 completed 拦掉并注明"MVP 不支持"——那是**前端口径**，
 *              服务端真要支持时改的是状态机，不是这里。
 * @limitation 三：改址**不因拒付被拦**（`addressGuard` 不看 has_dispute）：
 *              改址不动钱也不动货，拦它只会让"客户在争议期间要求改收货地址"变成无解。
 *
 * @see domain/order.ts（迁移表唯一真源）；app/admin-order-routes.ts（唯一调用方）；
 *      admin-web/src/orders/view.ts（前端三个闸门，口径必须与本文件一致）；
 *      packages/shared/src/limits.ts（退款理由上限的唯一真源，B7 / AJ-191）
 */
import {
  ADMIN_NOTE_MAX_LENGTH,
  REFUND_REASON_MAX_LENGTH,
  SHIP_MAX_CHARS,
  type ErrorCode,
  type OrderStatus,
} from '@waselect/shared';
import { canTransition } from './order.js';

/**
 * 判定结果：`ok:false` 时 `reason` 只进日志与 details（契约 `Err` 只有 code/message）。
 * @why `code` 的类型是 **`ErrorCode` 字面量联合**而不是 `number`：路由层拿它直接
 *      `new AppError(gate.code, …)`，写成 number 就编译不过（AppError 只收已登记码）——
 *      于是"闸门返回一个根本不存在的错误码"这件事在编译期就被挡住，
 *      而不是等到客服看到一条 50000 才发现。
 */
export type AdminGateResult = { ok: true } | { ok: false; code: ErrorCode; reason: string };

const OK: AdminGateResult = { ok: true };

function deny(code: ErrorCode, reason: string): AdminGateResult {
  return { ok: false, code, reason };
}

/**
 * 发货准入：`paid → shipped`，且无进行中的拒付，且**不是审核期测试单**。
 * @param hasDispute `orders.has_dispute`（D-50）。
 * @param isTest `orders.is_test`（技术文档 §2.9 / AJ-179）：审核期 mock 单是**未付款即确认**的，
 *        发货 = 真货换假钱。拦在拒付与状态之前：它两样都可能"合格"（paid、无拒付），唯独这条不能放。
 *        缺省 false 只为存量调用口径不变；路由层一律显式传。
 */
export function shipGuard(
  status: OrderStatus,
  hasDispute: boolean,
  isTest = false,
): AdminGateResult {
  if (isTest) return deny(40902, 'test_order');
  if (hasDispute) return deny(40909, 'dispute_open');
  return canTransition(status, 'shipped') ? OK : deny(40902, `status_${status}`);
}

/**
 * 退款准入：`paid|shipped|delivered → refunding`，且无进行中的拒付（D-50：40907）。
 *
 * ⚠️ 两个判定的**顺序**本身是结论（第三轮审查 OPS3-03 改过一次，见函数体内的 @why）：
 * · `refunding` 重试放行**先于**拒付：refunding 下的再点只是查询或同键重放，不动钱；
 *   拒付下挡死它 = 订单永久停在 refunding。会动钱的"换新键"由 `refund-execution.ts` 拦。
 * · 拒付仍然**先于**其余状态判定：一笔钱已经在争议里，再发一笔退款等于
 *   "同一笔扣款退两次"（机构侧 dispute 若判定我们赢，退款也回不来）；
 *   而状态码（40902）会把这个原因说成"状态不对"——客服照它去改状态，越改越错。
 *
 * @limitation 本闸门只看 `status × has_dispute`，**看不出这一把是不是新键**——
 *      它连"上一次退款到哪里"都不知道（那在 `findRefundProgress` 里）。
 *      所以 40907 的**最终**判定点在 `app/refund-execution.ts`，本闸门是它的前置宽判。
 *      两处口径必须一起改，否则会出现"闸门放行、执行也放行"的双退路径。
 */
export function refundGuard(status: OrderStatus, hasDispute: boolean): AdminGateResult {
  // `refunding` 放行 = **重试**（KD-4，AJ-175）：上一次机构调用失败/超时后订单停在 refunding，
  // 路由头注释承诺"可人工重试"，但原判定只认状态机迁移，refunding → refunding 不在表里 → 40902，
  // 这张单从此退不了、也回不去。重试不是迁移（状态机表保持不变），双扣由机构侧幂等键兜住
  // （同一订单同一键 `refund:<orderId>`，且重试沿用首次的退款理由，保证同键同参）。
  //
  // ⚠️ 它必须**先于**拒付判定（第三轮审查 OPS3-03，原顺序是拒付在前）：
  //    refunding 下的再次点击只有两条路——**查询**在途那笔，或用**同一把幂等键**重放，
  //    两条都不会让钱再动一次（`refund:<orderId>` 同键同参，机构回放首次结果）；
  //    而拒付在途时把它们挡死的结果是：退款 pending → 买家发起拒付 → 管理员再点想落定 → 40907
  //    ⇒ 订单永远停在 refunding，`stuck_refunds` 每天报警但没人处理得了（钱卡在中间态）。
  //    真正会动第二笔钱的是"换新键重新发起"，那一步的拦截**下移**到
  //    `app/refund-execution.ts`（那里才知道这一把是不是新键），本闸门管不到。
  // @tradeoff 代价是拒付在途时仍可能把一笔同键重放的退款落定（买家既拿到退款又赢了拒付）。
  //      选它是因为另一个方向的后果更硬：订单永久卡在 refunding 且**没有任何出口**；
  //      而同键重放的钱只可能动一次，动完后 `has_dispute` 仍在，对账看得见。
  if (status === 'refunding') return OK;
  if (hasDispute) return deny(40907, 'dispute_open');
  return canTransition(status, 'refunding') ? OK : deny(40902, `status_${status}`);
}

/**
 * 改址准入：**仅 `paid`**（契约："发货前改址"）。
 * @why 写成 `status === 'paid'` 而不是 `canTransition(...)`：改址**不是状态迁移**
 *      （改完还是 paid），拿迁移表判定它属于用错工具——
 *      迁移表回答的是"能不能到另一个状态"，而这里问的是"快照还能不能改"。
 */
export function addressGuard(status: OrderStatus): AdminGateResult {
  return status === 'paid' ? OK : deny(40902, `status_${status}`);
}

/**
 * 退款理由的校验结果：`ok:true` 时 `reason` 是**已 trim 过**的待落库文本。
 */
export type RefundReasonResult =
  { ok: true; reason: string } | { ok: false; code: ErrorCode; reason: string };

/**
 * 退款理由准入（B7 / AJ-191）：非空，且不超过 `REFUND_REASON_MAX_LENGTH`。
 *
 * @why 上限必须**在入口就拒**，而不是交给机构去拒：理由会原样写进 Stripe 的
 *      `metadata[reason]`，超长时机构拒这笔退款；而 KD-4（AJ-175）要求人工重试
 *      **沿用首次理由**（同键同参），`order_events` 又是 append-only——
 *      于是"第一次填太长"这件事会把订单钉死在 refunding，之后再点多少次都是同一个错。
 *      **入口拒绝**把这条链断在最前面：理由根本进不了库，订单也根本不会进 refunding。
 * @why 与 `refundGuard` 分开：`refundGuard` 问的是"这张单现在能不能退"（状态 × 拒付），
 *      本函数问的是"这段文本能不能当理由"。合起来会让"状态不对"和"理由太长"
 *      争同一个 40001，而它们的处置完全不同（前者重试也没用，后者改短就行）。
 *
 * @limitation trim 之后再判空与量长度：全角空格（U+3000）也被 `.trim()` 去掉，
 *      所以"打一串空格"不会蒙混过关。代价是理由的首尾空白不被保留——退款理由是
 *      审计台账给人读的，首尾空白没有信息量。
 * @limitation 量的是 **UTF-16 码元**（见 `REFUND_REASON_MAX_LENGTH` 的 @limitation），
 *      含 emoji 的理由会比机构口径早一点被拒；这是刻意选的保守方向。
 *
 * @see packages/shared/src/limits.ts（上限唯一真源）；app/admin-order-routes.ts（唯一调用方）
 */
/**
 * 管理端自由文本的通行校验：**必填 + 不超过上限**，返回已 trim 的文本。
 *
 * @why 抽出来而不是让每处各写一遍 if：这类校验的失败模式是"某处漏了长度判断"，
 *      而漏了之后不会报错，只是那一处能存进任意长的文本——
 *      等到审计台账里出现一篇长文才发现。抽成一处，新增字段就没有"忘了判长度"这个选项。
 * @why 失败 reason **由调用方给**（而不是在这里写死一组）：它们进 `Err.details` 也要进日志，
 *      必须能区分"退款理由太长"与"解除理由太长"，合成一个词等于把两个现场混成一个。
 */
function textGuard(
  raw: unknown,
  max: number,
  emptyReason: string,
  longReason: string,
): RefundReasonResult {
  if (typeof raw !== 'string') return { ok: false, code: 40001, reason: emptyReason };
  const text = raw.trim();
  if (text === '') return { ok: false, code: 40001, reason: emptyReason };
  if (text.length > max) return { ok: false, code: 40001, reason: longReason };
  return { ok: true, reason: text };
}

export function refundReasonGuard(raw: unknown): RefundReasonResult {
  return textGuard(
    raw,
    REFUND_REASON_MAX_LENGTH,
    'refund_reason_required',
    'refund_reason_too_long',
  );
}

/**
 * 2026-10-02（AJ-291）：本常量已移到 `packages/shared/src/limits.ts`——
 * 原先"不放进 shared"的理由是"没有前端消费方"，而管理端补上「人工解除拒付限制」按钮
 * （AJ-194 的前端待办）之后这个理由不成立；留下来的话前端要再写一个 500，那是第三份。
 * 此处改为从 shared 转出，调用方无需改动。
 */
export { ADMIN_NOTE_MAX_LENGTH };

/**
 * "人工解除拒付限制"的理由校验（B1b / AJ-194）。
 *
 * @why 理由**必须**填：这个口能把一张"钱可能已被机构拉回"的订单解锁成可发货、可退款，
 *      是管理端权限最大的动作之一。没有理由的解锁在审计里就是一条说不清的记录，
 *      而事后追问"当时为什么解开"一定发生在**出事之后**——那时没有理由就没有答案。
 * @limitation 不校验"理由是否充分"（机器判断不了），也不要求最短长度
 *      （逼人填满 `aaaa` 比留一句短话更糟）。
 */
export function releaseReasonGuard(raw: unknown): RefundReasonResult {
  return textGuard(
    raw,
    ADMIN_NOTE_MAX_LENGTH,
    'release_reason_required',
    'release_reason_too_long',
  );
}

/** 发货表单的校验结果（AJ-315）：`ok:true` 时两个值都**已 trim**。 */
export type ShipInfoResult =
  | { ok: true; carrier: string; trackingNo: string }
  | { ok: false; code: ErrorCode; reason: string };

/**
 * 发货表单准入：**两个字段都必填，且都不超过列宽**（AJ-315）。
 *
 * @why 长度必须**在入口判**——此前只判非空（第二轮审查 B24）：
 *      `orders.carrier` 是 VARCHAR(32)、`tracking_no` 是 VARCHAR(64)（迁移 001），
 *      超长撞 PG 的 22001 → 兜底层把它折成泛化的 **40001**（`http.ts` 的 22 类映射，
 *      reason 带 `sql_data_exception:22001`）。运营看到的不是"运单号太长"而是
 *      "参数缺失或格式错误"，提示指向了**错误的字段**；发货又在事务里，
 *      每次失败都把这张单回滚回 paid——她会以为是自己没点上，于是再点一次。
 * @why 两个 reason **分开**给（`carrier_too_long` / `tracking_no_too_long`，而不是合成一个
 *      `ship_fields_invalid`）：它们进日志，得能一眼看出是**哪一列**撞了列宽；
 *      合成一个词等于把两个现场混成一个（与 `textGuard` 的 @why 同口径）。
 * @why 与 `shipGuard` **分开**：`shipGuard` 问"这张单现在能不能发货"（状态 × 拒付 × 测试单），
 *      本函数问"这两个文本能不能落库"。合起来会让"状态不对"与"运单号太长"争同一个码，
 *      而两者的处置完全不同（前者重试也没用，后者改短就行）——
 *      与 `refundGuard` / `refundReasonGuard` 那一对是同一条分工。
 * @limitation 按 **UTF-16 码元**量长度（JS 的 `.length`），而 PG 的 `VARCHAR(n)` 按**字符**量：
 *      含 emoji / 部分罕用汉字的运单号会比库口径早一点被拒。方向是保守的——
 *      少收一个字符只是提示早一点，多收一个就是上面那条 40001。
 *
 * @see packages/shared/src/limits.ts（`SHIP_MAX_CHARS` 唯一真源）；
 *      app/admin-order-routes.ts（唯一调用方）；admin-web/src/orders/view.ts（`shipErrors`）
 */
export function shipInfoGuard(raw: unknown): ShipInfoResult {
  const b = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const carrier = typeof b['carrier'] === 'string' ? b['carrier'].trim() : '';
  const trackingNo = typeof b['tracking_no'] === 'string' ? b['tracking_no'].trim() : '';
  if (carrier === '' || trackingNo === '') {
    return { ok: false, code: 40001, reason: 'carrier_tracking_no_required' };
  }
  if (carrier.length > SHIP_MAX_CHARS.carrier) {
    return { ok: false, code: 40001, reason: 'carrier_too_long' };
  }
  if (trackingNo.length > SHIP_MAX_CHARS.tracking_no) {
    return { ok: false, code: 40001, reason: 'tracking_no_too_long' };
  }
  return { ok: true, carrier, trackingNo };
}

/**
 * 退款理由的**确定性截断**（适配器侧纵深防御，B7 / AJ-191）。
 *
 * @why 路由入口已经拒掉超长理由，所以这个函数看起来"永远不会被触发"——
 *      它服务的不是新请求，而是**存量数据**：本上限上线之前写进 `order_events`
 *      的那些超长理由改不了也删不掉（append-only），而 KD-4 要求重试沿用首次理由。
 *      那种订单今天唯一的出口就是"截断后再发"，否则它永久停在 refunding。
 * @why 截断必须是**确定性的**（同一输入永远同一输出）：重试之间若截出不同文本，
 *      就是同键异参，机构会直接 400——比不截断更糟。
 *
 * @limitation 截断会改变理由文本，严格说破坏了同键同参。选它是因为方向对：
 *      让这笔退款**发得出去**，而不是继续被机构拒。且它只影响上限生效前的存量数据。
 * @limitation 按码元切（`.slice`）可能把代理对切成两半，产生一个半个 emoji。
 *      不修：那是存量脏数据的**展示**瑕疵，不影响机构接受与否，
 *      而为了它引入码点切分会给一条防御路径加上不必要的复杂度。
 *
 * @see adapters/payment/stripe-checkout.ts（唯一调用方：metadata[reason]）
 */
export function clipRefundReason(reason: string): string {
  return reason.length > REFUND_REASON_MAX_LENGTH
    ? reason.slice(0, REFUND_REASON_MAX_LENGTH)
    : reason;
}
