/**
 * 职责：管理端「发货前改址」的表单模型与格式校验（纯函数层）。
 *
 * @why 与 `miniprogram/utils/address-form.js` **同源但两份**：
 *      小程序是独立 JS 运行时（不参与本仓 TS 构建），管理端是 Vite/TS，
 *      两端**拿不到同一个模块**（让 admin-web import 小程序目录会把两条交付链缠在一起——
 *      小程序每次改字段都要连带构建管理端）。
 *      所以两处都以**契约 `AddressInput` 为唯一真源**，各自与 yaml 的 pattern 双向比对
 *      （`address-view.unit.test.ts` 与小程序 `address-form.unit.test.ts` 各一份）——
 *      契约改了而某一端没跟，那一端的 gate 立刻红。
 *      ⚠️ 这是**已知且被守住的重复**，不是疏漏；将来若抽出共享包，这份应被删掉而不是留着。
 *
 * @why 改址要**重复一遍**契约校验：改址写的是订单的地址快照，
 *      写错一个字段（电话少了 +1）是**面单打不出来**，而面单要到发货那一刻才发现。
 *
 * @limitation 一：**不带 `is_default`**——改的是"这一单寄到哪"，不是"用户默认地址"，
 *              带上它会把订单快照语义和用户地址簿语义混在一起（契约里它是可选项）。
 * @limitation 二：`country` 恒为 `US`（MVP 单一目的国，与小程序 `ADDRESS_COUNTRY_DEFAULT` 同口径）。
 *
 * @see ../../../contracts/api-contract.yaml（AddressInput）；./api.ts（updateOrderAddress）
 */
import {
  US_STATES,
  isUsStateCode,
  normalizeTypedAddress,
  normalizeUsPhone,
  zipMatchesState,
} from '@waselect/shared';

/** MVP 唯一目的国（@see @limitation 二）。 */
export const ADDRESS_COUNTRY_DEFAULT = 'US';

/**
 * 与契约 `AddressInput.pattern` **同源**的正则（改这里先确认契约没改）。
 * @see 文件头的双向比对说明
 */
export const ADDRESS_PATTERNS = {
  /** `^[ -~]+$`：可打印 ASCII（美国面单不接受全角 / 日文）。 */
  ascii: /^[ -~]+$/,
  /** `^[ -~]*$`：同上但允许为空（`line2` 可省）。 */
  asciiOptional: /^[ -~]*$/,
  /** `^\+1[0-9]{10}$`：北美号码，带国家码。 */
  phone: /^\+1[0-9]{10}$/,
  /** `^\d{5}(-\d{4})?$`：5 位 ZIP 或 ZIP+4。 */
  postal: /^\d{5}(-\d{4})?$/,
  /** 州缩写（契约只约束长度 2；大小写归一，见 `addressFormModel`）。 */
  state: /^[A-Z]{2}$/,
};

/** 表单字段顺序（= 页面表单顺序；不含 country / is_default，@see @limitation 一/二）。 */
export const ADDRESS_FIELDS = [
  'recipient',
  'phone',
  'line1',
  'line2',
  'city',
  'state',
  'postal_code',
] as const;

export type AddressField = (typeof ADDRESS_FIELDS)[number];

/** 地址表单（全字符串：受控输入的值恒为字符串）。 */
export type AddressForm = Record<AddressField, string>;

export function emptyAddressForm(): AddressForm {
  return { recipient: '', phone: '', line1: '', line2: '', city: '', state: '', postal_code: '' };
}

/**
 * 订单（`AdminOrder`）→ 地址表单（预填当前地址）。
 * @why 逐字段读而不是展开 `order.address`：地址对象是**外部输入**，
 *      铺进去会把未知字段一路带进请求体（服务端 40001），而报错指向请求体不指向表单。
 */
export function addressFormModel(order: unknown): AddressForm {
  const src = (order as { address?: unknown } | null)?.address;
  const a = (typeof src === 'object' && src !== null ? src : {}) as Record<string, unknown>;
  // 先归一（两端输入测试 2026-10-12）：从聊天里复制的地址常带弯引号 / 全角数字，原先一律"请用英文填写"
  const text = (k: string): string =>
    typeof a[k] === 'string' ? normalizeTypedAddress(a[k] as string) : '';
  return {
    recipient: text('recipient'),
    phone: text('phone'),
    line1: text('line1'),
    line2: text('line2'),
    city: text('city'),
    // 州名大小写归一：小写 `ca` 在报关与面单上会被当成另一个值，自动转比报错友好
    state: text('state').toUpperCase(),
    postal_code: text('postal_code'),
  };
}

/** 表单校验（返回全部字段级错误 + 第一条）。 */
export function addressFormErrors(form: unknown): {
  ok: boolean;
  errors: Partial<Record<AddressField, string>>;
  first: string;
} {
  const m = addressFormModel({ address: form });
  const errors: Partial<Record<AddressField, string>> = {};
  if (!ADDRESS_PATTERNS.ascii.test(m.recipient.trim()))
    errors['recipient'] = '收件人请用英文/数字填写（面单不支持中文或全角）';
  // 美国日常写法先凑成 +1…（与小程序同一规则，shared normalizeUsPhone；两端输入测试 2026-10-12）
  if (!ADDRESS_PATTERNS.phone.test(normalizeUsPhone(m.phone)))
    errors['phone'] = '电话请填美国 10 位号码，如 206 555 0123（可带 +1）';
  if (!ADDRESS_PATTERNS.ascii.test(m.line1.trim())) errors['line1'] = '地址第一行请用英文/数字填写';
  if (!ADDRESS_PATTERNS.asciiOptional.test(m.line2.trim()))
    errors['line2'] = '地址第二行请用英文/数字填写（可留空）';
  if (!ADDRESS_PATTERNS.ascii.test(m.city.trim())) errors['city'] = '城市请用英文/数字填写';
  // 形状之外再查 USPS 州码白名单（与服务端 / 小程序同源，AJ-371；工程缺口第二轮 §3.6 #3）
  if (!ADDRESS_PATTERNS.state.test(m.state.trim()) || !isUsStateCode(m.state.trim()))
    errors['state'] = '州请填美国州或领地的两位缩写，如 CA';
  if (!ADDRESS_PATTERNS.postal.test(m.postal_code.trim()))
    errors['postal_code'] = '邮编为 5 位或 ZIP+4，如 94105 或 94105-1234';
  // 全入口点击测试 2026-10-11：邮编与州各自合法、但对不上（多半是州写错一个字母）——报在邮编上，说清当前州（与小程序同一句）
  if (
    errors['postal_code'] === undefined &&
    errors['state'] === undefined &&
    !zipMatchesState(m.postal_code, m.state)
  ) {
    const st = m.state.trim().toUpperCase();
    const name = US_STATES.find((r) => r.code === st)?.name ?? st;
    errors['postal_code'] = `邮编 ${m.postal_code.trim()} 不属于 ${name}（${st}）——请检查州或邮编`;
  }
  const first = Object.values(errors)[0] ?? '';
  return { ok: Object.keys(errors).length === 0, errors, first };
}

/**
 * 表单 → 契约 `AddressInput`。
 * @why `line2` 空串**仍带上**：契约允许空串，删掉字段会让"清空第二行"变成"第二行不变"——
 *      运营清了却没生效，且从 UI 上看不出区别。
 * @limitation 三：**不校验**（校验在 `addressFormErrors`，调用方先过一遍）。
 *              这里顺手校验会变成"两处都能拒，但只有一处会提示"。
 */
export function toAddressInput(form: unknown): Record<string, string> {
  const m = addressFormModel({ address: form });
  return {
    recipient: m.recipient.trim(),
    phone: normalizeUsPhone(m.phone),
    line1: m.line1.trim(),
    line2: m.line2.trim(),
    city: m.city.trim(),
    state: m.state.trim().toUpperCase(),
    postal_code: m.postal_code.trim(),
    country: ADDRESS_COUNTRY_DEFAULT,
  };
}
