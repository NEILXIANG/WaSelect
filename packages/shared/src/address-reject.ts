/**
 * 职责：地址被服务端拒（40002，`data {field, reason?}`，AJ-498）时给用户看的话——小程序地址编辑与后台改址共用。
 *
 * @why 原先两端都显示服务端通用文案"地址须为英文/拼音或电话格式错误"：邮编与州对不上也这么说，方向是错的
 *      （业务旅程测试 2026-10-12）。两端各自都有预检，走到这里多是旧版本客户端或预检漏了——更要说准。
 * @why 放 shared：后台直接用；小程序运行时引不了本包，留副本（miniprogram/utils/address-form.js），由单测逐项比对。
 * @limitation 认不出的字段 / 原因返回 null，由调用方退回通用文案（不编）。
 */
export const ADDRESS_REJECT_TEXT: Readonly<Record<string, string>> = {
  zip_state_mismatch: '邮编和州对不上：请检查州或邮编',
  recipient: '收件人请用英文或拼音（面单是给美国承运商看的）',
  line1: '街道地址请用英文填写',
  line2: '门牌 / 公寓号请用英文或数字填写',
  city: '城市请用英文填写',
  phone: '电话请填美国号码：10 位数字',
  state: '请从下拉里选择州',
  postal_code: '邮编应为 5 位数字（或 5 位加 4 位，如 94133-1234）',
  country: '暂不支持寄往这个国家或地区',
};

/** `data {field, reason?}` → 人话；认不出返回 null。原因优先（同一字段可能有不同原因）。 */
export function addressRejectText(data: unknown): string | null {
  const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const reason = typeof d['reason'] === 'string' ? ADDRESS_REJECT_TEXT[d['reason']] : undefined;
  if (reason !== undefined) return reason;
  const field = typeof d['field'] === 'string' ? ADDRESS_REJECT_TEXT[d['field']] : undefined;
  return field ?? null;
}
