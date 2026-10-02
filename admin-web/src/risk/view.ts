/**
 * 职责：风控页的**视图纯函数**（拒付列表行 / 拉黑）。
 *
 * @why 拒付（chargeback）是**钱已经被拿走**的一类事件：败诉 = 货款两空。
 *      所以列表要给足"一眼判断轻重"的信息——金额、状态、开案时间，
 *      并按状态排序（进行中在最前），否则运营会先看到一堆已结案的、把进行中的漏过去。
 *
 * @limitation 一：契约 `Dispute` **没有 `user_id`**（只有 order_id / payment_id），
 *      而"拉黑用户"要的是 user_id——所以拉黑必须**先取订单详情**（`GET /admin/orders/{id}`）。
 *      这条链路是契约形状决定的，不是设计偏好；将来 Dispute 补上 user_id 可以省掉一次往返。
 * @limitation 二：契约**只有拉黑、没有解除**——拉黑是**不可逆**的（除非直连数据库）。
 *      所以 UI 必须二次确认并明确写出后果（此后该用户建单 40301）。
 *
 * @see ../../../contracts/api-contract.yaml（Dispute、/admin/users/{id}/block）；../format.ts
 */
import { formatJst, minorMoneyText } from '../format.js';

/** 契约 `Dispute.dispute_status` 枚举（单测与契约双向比对）。 */
export const DISPUTE_STATUS = ['open', 'won', 'lost', 'withdrawn'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUS)[number];

/**
 * 展示名（契约只给 key）。
 *
 * ⚠️ `withdrawn`（B1 / AJ-193）= 机构撤回 / 未进入正式拒付（查询函关闭、Radar 拦下），
 *    **没有输赢**，所以文案**不能**写成"已胜诉"或"已败诉"——那会让运营以为这笔钱
 *    要么回来了、要么没了，而事实是争议压根没走到判决。
 */
export const DISPUTE_STATUS_LABELS: Readonly<Record<DisputeStatus, string>> = {
  open: '进行中',
  won: '已胜诉',
  lost: '已败诉',
  withdrawn: '已撤回（不计输赢）',
};

/**
 * 拉黑后果的固定文案（@see @limitation 二：没有解除接口，点之前必须说清）。
 *
 * @why 三件后果**必须逐条列出**，尤其是第二条：
 *      拉黑不是"只把这个人挡在门外"——`app/block-user.ts` 会**连带取消**该用户名下
 *      所有在途单（`created` / `pending_payment`）并回补库存、作废在途支付行。
 *      2026-10-02 的 L4 浏览器验收发现：确认面板只说了"不能再下单"与"没有解除入口"，
 *      运营点下去之后才知道"这个人的未付款订单也没了"——
 *      而那一步不可逆，且界面上没有任何一处提示过它。
 *      ⚠️ 二审（ADR）：不可写在服务端日志里就完事——运营是在**点之前**需要知道它。
 *
 * @limitation 文案里不写"会取消几张单"：接口返回空体 200（`admin-risk-routes.ts`
 *             @why），前端拿不到条数；写死一个数字比不写更糟。核对方式给"去订单列表"。
 */
export const BLOCK_CONFIRM_TEXT =
  '拉黑后：① 该用户不能再下单（40301）；② 其名下**未付款**的订单（待付款 / 支付中）会被立即取消、库存回补；③ 后台没有解除入口。确认继续？';

/**
 * 拉黑成功后的提示（@see {@link BLOCK_CONFIRM_TEXT} 的 @limitation：条数拿不到，
 * 所以只说"已一并取消"，并把核对动作指向订单列表）。
 */
export function blockDoneText(userId: string): string {
  return `已拉黑 ${userId}（此后建单会被拒 40301；其名下未付款订单已一并取消——到「订单管理」按该用户核对）`;
}

/** 列表行。 */
export interface DisputeRow {
  orderId: string;
  orderNo: string;
  disputeId: string;
  status: DisputeStatus | null;
  statusText: string;
  /** 金额是**原币**（契约：`dispute_amount` + `charge_currency`），不是 JPY。 */
  amountText: string;
  openedText: string;
  closedText: string;
  /** 进行中排最前（@why 见文件头）。 */
  urgent: boolean;
}

/** `Dispute[]` → 列表行。 */
export function disputeRows(items: unknown): DisputeRow[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
    .map((d) => {
      const status = (DISPUTE_STATUS as readonly string[]).includes(String(d['dispute_status']))
        ? (String(d['dispute_status']) as DisputeStatus)
        : null;
      const currency = typeof d['charge_currency'] === 'string' ? d['charge_currency'] : '';
      // ⚠️ dispute_amount 是**最小单位**（USD=分），直接拼会把 33.50 美元显示成 3350（B43 / AJ-214）
      const amount = minorMoneyText(d['dispute_amount'], currency);
      return {
        orderId: typeof d['order_id'] === 'string' ? d['order_id'] : '',
        orderNo: typeof d['order_no'] === 'string' ? d['order_no'] : '',
        disputeId: typeof d['dispute_id'] === 'string' ? d['dispute_id'] : '',
        status,
        statusText: status === null ? '未知状态' : DISPUTE_STATUS_LABELS[status],
        // 币种符号已含在 amountText 里（`minorMoneyText`），不再重复拼代码：
        // "USD $33.50" 里 USD 与 $ 说的是同一件事，多一个词只是多一处要维护
        amountText: amount,
        openedText: formatJst(d['opened_at']),
        closedText: formatJst(d['closed_at']),
        urgent: status === 'open',
      };
    })
    .sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

/** 从订单详情里取 `user_id`（拉黑要用；@see @limitation 一）。 */
export function orderUserId(order: unknown): string {
  const id = (order as { user_id?: unknown } | null)?.user_id;
  return typeof id === 'string' ? id : '';
}
