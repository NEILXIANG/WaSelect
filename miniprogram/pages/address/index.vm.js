/**
 * 职责：地址列表页（`pages/address`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 列表行的三处判断都**错了不报错**：
 *      ① 摘要直接拼字段 → 缺 city 时出 `San Francisco, , CA` 双逗号（真机上就是"地址错了"）；
 *      ② 默认标记读 `is_default` 之外的东西 → 两个页面标的不一样；
 *      ③ 坏条目（没 id）不丢 → 渲染出一个点不动的行（`bindtap` 拿到空 id）。
 *
 * @limitation 一：本 vm **只做渲染**，不管"选中哪个"（那是页面的 `data.pickedId`）；
 *              选中态是交互状态不是派生数据，放进纯函数只会让函数多一个参数、多一种错法。
 *
 * @see ../../utils/address-form.js（摘要与默认 id 的真源）
 */
import { addressSummary } from '../../utils/address-form.js';

/**
 * 服务端 `Address[]` → 列表行。
 * @param {unknown} list `GET /addresses` 的响应
 * @returns {Array<{id: string, recipient: string, phone: string, line1: string,
 *                  line2: string, region: string, isDefault: boolean, defaultText: string}>}
 * @why 没 `id` 的条目**直接丢掉**：点它拿不到 id，请求会打到 `/addresses/undefined`，
 *      而列表里那一行的样子和正常行**完全一样**——用户只会以为"这个地址删不掉"。
 */
export function addressRows(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.id === 'string' && a.id !== '')
    .map((a) => {
      const s = addressSummary(a);
      const isDefault = a.is_default === true;
      return {
        id: a.id,
        recipient: s.recipient,
        phone: s.phone,
        line1: s.line1,
        line2: s.line2,
        region: s.region,
        isDefault,
        // ⚠️ 文案在 vm 里给而不是 wxml 里 `wx:if` 拼：WXML 里写死 "默认" 会让
        //    多语言（本项目有 zh/ja/en 三语条款）在列表页变成另一个口径
        defaultText: isDefault ? '默认' : '',
      };
    });
}

/**
 * 是否"一个地址都没有"（空态文案开关）。
 * @why 与 `rows.length === 0` 分开给：空态要区分"没地址"和"还没取到/取失败"——
 *      加载失败时显示"还没有地址"是**说假话**（用户会以为自己没存过）。
 */
export function emptyState(rows, error) {
  return { showEmpty: Array.isArray(rows) && rows.length === 0 && error === '' };
}

const ERROR_TITLES = {
  load: '没能取到地址',
  delete: '删除没有成功，地址还在',
  default: '设为默认没有成功',
};

/**
 * 错误块的标题（审查 2026-10-09）：删除 / 设默认失败此前也写"没能取到地址"，用户不知道删没删掉。
 * @param {unknown} kind 'load' | 'delete' | 'default'；不认识 → 'load' 的说法
 */
export function errorTitle(kind) {
  return ERROR_TITLES[kind] ?? ERROR_TITLES.load;
}

/**
 * 删除确认框的正文（全入口点击测试 2026-10-11）：说清删的是哪一条。
 * @why 原先只写"删除后不可恢复，确定删除？"——地址多时点错了行，确认框里看不出来。
 * @param {unknown} row `addressRows` 的一行（找不到时传 undefined）
 * @returns {string}
 */
export function deleteConfirmText(row) {
  const r = row !== null && typeof row === 'object' ? row : {};
  const parts = [r.recipient, r.line1].filter((v) => typeof v === 'string' && v !== '');
  if (parts.length === 0) return '删除后不可恢复，确定删除？';
  return `将删除「${parts.join(' · ')}」，删除后不可恢复。`;
}
