/**
 * 职责：售后申请页（`pages/after-sale`，AJ-420）的视图逻辑——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 原因必选、描述必填：运营拿到"商品破损"四个字没法处理，要知道破在哪、什么程度；
 *      描述按**字符**计数（`[...s]`），与服务端同口径——按码元计时 emoji 多算一位，页面说"还能输 1 字"、提交却被拒。
 * @why 40902 的两种原因给**具体**说法（已有进行中的申请 / 订单状态不能申请），其余错误交给薄壳的通用错误文案：
 *      这两种是买家能理解、能据此行动的（回订单详情看进度），通用文案"操作失败 40902"不能。
 * @limitation 一：不带照片（MVP，服务端也不收）；页面上写明"需要照片请联系客服并提供订单号"。
 * @limitation 二：不做草稿保存，离开页面填的内容会丢（描述一般就几句话）。
 * @see ../../utils/after-sale.js（原因 / 上限的镜像）；server/src/domain/after-sale-input.ts
 */
import { AFTER_SALE_DESCRIPTION_MAX, AFTER_SALE_REASON_ROWS } from '../../utils/after-sale.js';

/** 原因下拉的选项文案（顺序 = AFTER_SALE_REASON_ROWS）。 */
export const REASON_LABELS = AFTER_SALE_REASON_ROWS.map((r) => r.label);

/** 页面打开时的空表单：原因未选（-1），描述空。 */
export function initialForm() {
  return { reasonIndex: -1, description: '' };
}

const chars = (s) => [...s].length;

/**
 * 表单展示：选中的原因、字数、是否超长。
 * @why 不再给"能不能提交"：按钮缺项时也要能点（由 submitBody 的提示说缺什么），见 index.wxml 注释。
 * @param {{reasonIndex: number, description: string}} form
 */
export function formView(form) {
  const row = AFTER_SALE_REASON_ROWS[form.reasonIndex];
  const n = chars(form.description.trim());
  return {
    reasonText: row === undefined ? '' : row.label,
    countText: `${String(n)}/${String(AFTER_SALE_DESCRIPTION_MAX)}`,
    overLimit: n > AFTER_SALE_DESCRIPTION_MAX,
  };
}

/**
 * 提交前校验并给出请求体；不合法时给出第一条提示。
 * @returns {{ok: true, body: {reason: string, description: string}} | {ok: false, error: string}}
 */
export function submitBody(form) {
  const row = AFTER_SALE_REASON_ROWS[form.reasonIndex];
  if (row === undefined) return { ok: false, error: '请选择问题类型' };
  const description = form.description.trim();
  const n = chars(description);
  if (n === 0) return { ok: false, error: '请描述一下遇到的问题' };
  if (n > AFTER_SALE_DESCRIPTION_MAX) {
    return { ok: false, error: `问题描述最多 ${String(AFTER_SALE_DESCRIPTION_MAX)} 字` };
  }
  return { ok: true, body: { reason: row.value, description } };
}

/**
 * 提交失败里**买家能据此行动**的那两种（40902）；其它返回 null（交给通用错误文案）。
 * @param {unknown} err 请求层抛出的错误（`{code, data}`）
 */
export function conflictText(err) {
  const e = err && typeof err === 'object' ? err : {};
  if (e.code !== 40902) return null;
  const reason = e.data && typeof e.data === 'object' ? e.data.reason : undefined;
  if (reason === 'after_sale_open') return '这笔订单已有进行中的售后申请，请返回订单详情查看进度';
  if (reason === 'status_not_allowed') return '这笔订单当前不能申请售后（已发货后才可以申请）';
  return null;
}
