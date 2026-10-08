/**
 * 职责：「离开会丢掉未保存的修改」确认弹层的**唯一文案**——App 侧栏拦截、商品页「返回列表」、Banner 页切换编辑对象共用。
 * @why 三处各写一份会漂：审查（2026-10-09）发现商品页「返回列表」与 Banner 页切换根本没拦，补拦时文案必须与侧栏那份一字不差，
 *      运营才会把它们认成同一件事。
 */
import type { ConfirmSpec } from './confirm.js';

export const LEAVE_UNSAVED_SPEC: ConfirmSpec = {
  title: '离开这一页会丢掉未保存的修改',
  body: '改了但没保存的内容不会被写入（这一页也不做本地草稿）。先回去点「保存」，或直接放弃。',
  confirmText: '放弃修改并离开',
  danger: true,
};
