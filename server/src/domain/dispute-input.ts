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
