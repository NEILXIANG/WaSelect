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
 *      admin-web/src/orders/view.ts（前端三个闸门，口径必须与本文件一致）
 */
import type { ErrorCode, OrderStatus } from '@waselect/shared';
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
 * 发货准入：`paid → shipped`，且无进行中的拒付。
 * @param hasDispute `orders.has_dispute`（D-50）。
 */
export function shipGuard(status: OrderStatus, hasDispute: boolean): AdminGateResult {
  if (hasDispute) return deny(40909, 'dispute_open');
  return canTransition(status, 'shipped') ? OK : deny(40902, `status_${status}`);
}

/**
 * 退款准入：`paid|shipped|delivered → refunding`，且无进行中的拒付（D-50：40907）。
 * @why 拒付拦在**状态判定之前**：一笔钱已经在争议里，再发一笔退款等于
 *      "同一笔扣款退两次"（机构侧 dispute 若判定我们赢，退款也回不来）；
 *      而状态码（40902）会把这个原因说成"状态不对"——客服照它去改状态，越改越错。
 */
export function refundGuard(status: OrderStatus, hasDispute: boolean): AdminGateResult {
  if (hasDispute) return deny(40907, 'dispute_open');
  // `refunding` 放行 = **重试**（KD-4，AJ-175）：上一次机构调用失败/超时后订单停在 refunding，
  // 路由头注释承诺"可人工重试"，但原判定只认状态机迁移，refunding → refunding 不在表里 → 40902，
  // 这张单从此退不了、也回不去。重试不是迁移（状态机表保持不变），双扣由机构侧幂等键兜住
  // （同一订单同一键 `refund:<orderId>`，且重试沿用首次的退款理由，保证同键同参）。
  if (status === 'refunding') return OK;
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
