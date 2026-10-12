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

/**
 * 打字带出来的"看着像英文、其实不是 ASCII"的字符 → ASCII（地址各栏校验与提交前先过一遍）。
 * @why 两端输入测试 2026-10-12：iPhone 英文键盘默认开"智能标点"，打 O'Farrell St 得到弯引号 ’；
 *      中文输入法全角模式打出 ９４１２３ / Ｚｈａｎｇ；从聊天里复制的地址常带不换行空格——原先一律"请用英文填写"，
 *      而用户写的本来就是英文。面单只收 ASCII，这几类换成等价的 ASCII 不改变意思。
 * @why NFKC 管全角与兼容字符（＃→#、全角空格→空格、不换行空格→空格）；弯引号与各种横线 NFKC 不管，单独换。
 * @limitation 中文、日文、emoji 原样保留——它们没有等价的 ASCII，仍由校验说"请用英文"。
 *             小程序运行时引不了本包，`miniprogram/utils/address-form.js` 留副本，由单测逐例比对。
 */
export function normalizeTypedAddress(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-');
}

/**
 * 美国电话的常见写法 → E.164（`+1` + 10 位）；认不出的原样 trim 返回，交给校验去拒（不猜）。
 * @why 两端输入测试 2026-10-12：小程序自 P2-37 起这样做，后台改址却只认 `+1` 开头——
 *      运营从聊天里复制的 "(206) 555-0123" 被拒。同一套规则挪到这里给后台用，小程序副本由单测比对。
 * @limitation 只认 10 位与 1 开头的 11 位；分隔符只认空格 ( ) - . 和开头一个 +；外国号、分机一律不动。
 */
export function normalizeUsPhone(raw: string): string {
  const s = raw.trim();
  if (!/^\+?[0-9 ().-]+$/.test(s)) return s;
  const digits = s.replace(/[^0-9]/g, '');
  const plus = s.startsWith('+');
  if (!plus && digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return s;
}
