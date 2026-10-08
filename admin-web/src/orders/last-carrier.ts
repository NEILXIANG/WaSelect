/**
 * 职责：记住"上一次批量发货用的承运商"（AJ-401），作为下一次的默认值。
 *
 * @why 存浏览器本地而不是服务端配置：这是**每个运营自己的**输入便利（她总用 EMS 还是 ヤマト），
 *      不是业务配置；没有它也只是多打一个词。服务端没有"默认承运商"配置项，也不为此新增。
 * @limitation 读写都包 try/catch：隐私窗口 / 禁用站点数据时 localStorage 会抛，此时退回空串（手填）。
 */
const KEY = 'ws.admin.lastCarrier';

export function readLastCarrier(): string {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveLastCarrier(carrier: string): void {
  const v = carrier.trim();
  if (v === '') return;
  try {
    globalThis.localStorage?.setItem(KEY, v);
  } catch {
    // 存不下就不存：下次手填
  }
}
