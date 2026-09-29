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
 * @see contracts/api-contract.yaml（/admin/disputes 的 status 参数、`Dispute.dispute_status` 枚举）；
 *      app/mark-disputed.ts（结案落库，消费 `DisputeResult`）；docs/自主决策记录.md AJ-193
 */
import { AppError } from '../errors.js';

/**
 * 契约 `Dispute.dispute_status` 枚举（顺序即文档顺序）。
 *
 * ⚠️ `withdrawn` 是 **B1 / AJ-193** 新增的第四态：机构**撤回**、争议**没有进入正式拒付**
 * （Stripe 查询函以 `warning_closed` 结案，或被 Radar 拦下 `prevented`）。
 * @why 它不是"赢"也不是"输"——没有输赢之分，所以**不能**复用 won / lost：
 *      记成 won 会把"我方其实什么都没答辩"写成"我方赢了"（财务口径失真，
 *      且赢了就不该再有任何补救动作）；记成 lost 会让它按败诉口径**永久保持**限制
 *      （AJ-176：`lost → has_dispute 保持 true`），于是这张单从此不能发货、不能退款。
 */
export const DISPUTE_STATUS = ['open', 'won', 'lost', 'withdrawn'] as const;

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

/** 我方结案结果。⚠️ `withdrawn` = 机构撤回 / 未进入正式拒付，**不计输赢**。 */
export type DisputeResult = 'won' | 'lost' | 'withdrawn';

/**
 * 机构拒付状态 → 我方**结案结果**；未结案或认不出 → undefined。
 *
 * @why 映射放在 domain 而不是适配器：适配器只做"原样回带机构说了什么"
 *      （@see ports/payment.ts disputeStatus 的 @limitation 一），
 *      认识业务词表是 domain 的事。分开放之后，机构改枚举名只需动这一张表。
 *
 * @why `warning_closed` / `prevented` 映射成 `withdrawn` 而不是返回 undefined（B1 / AJ-193）：
 *      它们**是结案**（争议到此为止），只是没有赢输。旧实现返回 undefined →
 *      `mount.ts` 抛 `dispute_result_unknown` → 机构不再重发 → `has_dispute` 永远是 true
 *      ⇒ 发货 40909、退款 40907、自动推进排除，全部**永久**生效，而唯一的写回点
 *      （`markDisputeClosed`）永远走不到。这不是"少了个显示字段"，是这张单死了。
 *      ⚠️ 本文件原先的注释写的是"open 的拒付收到 warning_closed 应当保持 open"，
 *      与 `mount.ts` 的实际行为**相反**（它会抛错而不是保持 open）——ADR-29：注释与事实不符即 bug。
 *
 * @why **仍然认不出就返回 undefined 而不是抛错**：是否拒绝落库由**落账方**决定——
 *      它才知道"这条拒付现在是什么状态、能不能接受这个结果"，
 *      而且它那侧的失败（`dispute_result_unknown`）是 **error 级 + 转对账**，
 *      比 domain 抛一个 500 更能让人看见。
 *
 * @limitation ⚠️ `charge_refunded`（机构已退款给持卡人）在业务上等于 **lost**（钱没了），
 *              但这里**故意不映射**——它与 lost 的后续动作不同
 *              （退款已由机构执行，我方不该再退一次），
 *              等 F12 售后明确"机构退款 vs 我方退款"的口径再定，现在按"认不出"处理。
 * @limitation `warning_needs_response` / `warning_under_review` / `needs_response` /
 *              `under_review` 一律 undefined——它们是**在途**状态，不是结案结果。
 *              把"还在答辩中"认成任何结案结果的后果最严重：举证期限可能还剩好几天，
 *              我方却按"已经结束"解锁了闸门。
 *
 * @see adapters/payment/stripe-checkout.ts（生产 `disputeStatus`）；
 *      app/mark-disputed.ts（消费方，决定认不出时怎么办）；app/mount.ts（把 undefined 转 error）
 */
export function parseDisputeResult(raw: string | undefined): DisputeResult | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'won' || raw === 'lost') return raw;
  // 机构撤回 / 未进入正式拒付（B1 / AJ-193）：解除限制、不计输赢
  if (raw === 'warning_closed' || raw === 'prevented') return 'withdrawn';
  return undefined;
}
