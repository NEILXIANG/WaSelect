/**
 * 职责：拒付列表查询参数的解析（I2 U-E1）——目前只有 `status` 一个（契约 enum）。
 *
 * @why 非法值必须 **40001 响亮失败**，不能静默当成"不过滤"：
 *      契约的 `status` 是 enum，前端下拉只会发这三个值之一；
 *      真出现第四种值时，来源一定是拼错的参数或脚本。而"当成不过滤"的表现是
 *      **列表突然变长、看起来像'最近拒付激增'**——运营会按错的结论去查业务，
 *      而没有任何一方报错（D-46 同类：错在显示层、静默、责任人看不见）。
 *
 * @why enum 清单不自己维护一份，而是由单测**与契约双向比对**（`dispute-input.unit.test.ts`）：
 *      抄一份清单 = 两端各有一份真源，改契约的那天就开始漂移；
 *      比对让"契约改了 enum"直接变成红灯（与 `banner-input.ts` 同口径）。
 *
 * @limitation 缺参数 / 空串 按"不过滤"处理（返回 undefined），**不是错误**：
 *              "看全部"是列表页的默认视图，是正常用法；只有"传了却不认识"才是错。
 *
 * @see contracts/api-contract.yaml（/admin/disputes 的 status 参数）；
 *      admin-web/src/risk/view.ts（DISPUTE_STATUS，展示侧的同源清单）
 */
import { AppError } from '../errors.js';

/** 契约 `Dispute.dispute_status` 枚举（顺序即文档顺序）。 */
export const DISPUTE_STATUS = ['open', 'won', 'lost'] as const;

export type DisputeStatus = (typeof DISPUTE_STATUS)[number];

/**
 * @returns undefined = 不过滤；否则为合法状态。
 * @throws {AppError} 40001（给了值但不认识；带 `reason` 供日志区分）
 */
export function parseDisputeStatus(raw: unknown): DisputeStatus | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  // Express 的 query 支持重复参数（`?status=a&status=b` → 数组），
  // 数组不是"某个合法状态"，按非法处理而不是取第一个——静默取第一个会选中一个运营没点的筛选项。
  if (typeof raw !== 'string' || !(DISPUTE_STATUS as readonly string[]).includes(raw)) {
    throw new AppError(40001, { reason: 'dispute_status_invalid', value: String(raw) });
  }
  return raw as DisputeStatus;
}

/**
 * 机构拒付状态 → 我方**结案结果**（won / lost）；未结案或认不出 → undefined。
 *
 * @why 映射放在 domain 而不是适配器：适配器只做"原样回带机构说了什么"
 *      （@see ports/payment.ts disputeStatus 的 @limitation 一），
 *      认识业务词表是 domain 的事。分开放之后，机构改枚举名只需动这一张表。
 *
 * @why **认不出就返回 undefined 而不是抛错**：结案事件到达时若结果是
 *      `warning_closed`（Stripe：机构撤回警告、未进入正式拒付）之类，
 *      那不是错误，只是"这条拒付没有赢输之分"。是否拒绝落库由**落账方**决定——
 *      它才知道"这条拒付现在是什么状态、能不能接受这个结果"（例如 open 的拒付
 *      收到 warning_closed 应当保持 open，不该报错）。
 *
 * @limitation 只认 `won` / `lost`；⚠️ `charge_refunded`（机构已退款给持卡人）
 *              在业务上等于 **lost**（钱没了），但这里**故意不映射**——
 *              它与 lost 的后续动作不同（退款已由机构执行，我方不该再退一次），
 *              等 F12 售后明确"机构退款 vs 我方退款"的口径再定，现在按"认不出"处理。
 *
 * @see adapters/payment/stripe-checkout.ts（生产 `disputeStatus`）；
 *      app/mark-disputed.ts（消费方，决定认不出时怎么办）
 */
export function parseDisputeResult(raw: string | undefined): 'won' | 'lost' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'won' || raw === 'lost') return raw;
  return undefined;
}
