/**
 * 职责：地址输入的**形状与格式**校验（I2 U-B2c 从 `app/address-routes.ts` 提取）。
 *
 * @why **必须只有一份**：管理端改址（`POST /admin/orders/{id}/address`）与买家地址簿
 *      （`POST/PUT /addresses`）收的是同一个 `AddressInput`。抄第二份的后果不是"多写几行"，
 *      而是"两处校验从此各自漂移"——哪天邮编规则一变，改了一处，
 *      另一处会继续放过（或继续拒绝）一个已经不存在的格式，
 *      而它错的样子是"某个入口提交失败但没有原因"（与 D-46 取档方向同类）。
 *
 * @why 只做**纯**校验（形状 / 列宽 / 格式），**不含国家**：
 *      "这个国家能不能下单"是 `country_profiles` 表驱动的事实（ADR-28），
 *      要查库 → 有 I/O → 留在调用方（路由）里做，本文件保持纯函数好测。
 *      代价：调用方必须记得自己还有这一步（两处调用点都已写明）。
 *
 * @limitation 一：`is_default` 对管理端改址**无意义**（订单快照里没有"默认"这回事），
 *              但为了与 `AddressInput` 同形状仍然解析出来——调用方忽略即可。
 *              不为它单独开一个分支：那等于承认"两个入口的形状可以不同"，
 *              而它们共享同一个契约 schema。
 * @limitation 二：错误码分两类且与契约一致——**40001**（形状：缺字段 / 超列宽）、
 *              **40002**（格式：非 ASCII / 电话 / 邮编 / state）。
 *              区分的意义在 action：40002 是"用户改一改就能对"，40001 多半是接口用错了。
 *
 * @see contracts/api-contract.yaml（AddressInput）；app/address-routes.ts；
 *      app/admin-order-routes.ts（第二个消费方）
 */
import { AppError } from '../errors.js';

/**
 * 列宽（与 001 的 VARCHAR 一致）：超长属"形状错"（40001），DB 兜底是最后一道。
 * 导出供小程序 `utils/address-form.js` 的同名常量做单测比对（TST3-02：前端原来不查长度，
 * 超长 line2 要到服务端才被拒）。
 */
export const ADDRESS_MAX_CHARS = {
  recipient: 100,
  phone: 20,
  line1: 200,
  line2: 200,
  city: 100,
  postal_code: 10,
} as const;
const LEN = ADDRESS_MAX_CHARS;

const ASCII_RE = /^[ -~]+$/;
const ASCII_OR_EMPTY_RE = /^[ -~]*$/;
const PHONE_RE = /^\+1[0-9]{10}$/;
const POSTAL_RE = /^[0-9]{5}(-[0-9]{4})?$/;

/** 校验后的地址值（与契约 `AddressInput` 逐字段同形）。 */
export interface AddressInputValue {
  recipient: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  is_default: boolean;
}

const REQUIRED = ['recipient', 'phone', 'line1', 'city', 'state', 'postal_code'] as const;

/**
 * 校验并取出地址输入（纯：不查库、不取时钟）。
 * @throws {AppError} 40001 形状 / 40002 格式（见文件头 @limitation 二）
 */
export function parseAddressInput(body: unknown): AddressInputValue {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object') throw new AppError(40001, { reason: 'body_shape' });

  for (const k of REQUIRED) {
    if (typeof b[k] !== 'string' || (b[k] as string).length === 0) {
      throw new AppError(40001, { reason: `${k}_required` });
    }
  }
  const input: AddressInputValue = {
    recipient: b['recipient'] as string,
    phone: b['phone'] as string,
    line1: b['line1'] as string,
    line2: b['line2'] === undefined || b['line2'] === null ? null : String(b['line2']),
    city: b['city'] as string,
    state: b['state'] as string,
    postal_code: b['postal_code'] as string,
    country: b['country'] === undefined ? 'US' : String(b['country']),
    is_default: b['is_default'] === true,
  };

  // 形状：列宽（40001）
  if (input.recipient.length > LEN.recipient)
    throw new AppError(40001, { reason: 'recipient_too_long' });
  if (input.phone.length > LEN.phone) throw new AppError(40001, { reason: 'phone_too_long' });
  if (input.line1.length > LEN.line1) throw new AppError(40001, { reason: 'line1_too_long' });
  if (input.line2 !== null && input.line2.length > LEN.line2) {
    throw new AppError(40001, { reason: 'line2_too_long' });
  }
  if (input.city.length > LEN.city) throw new AppError(40001, { reason: 'city_too_long' });
  if (input.postal_code.length > LEN.postal_code) {
    throw new AppError(40001, { reason: 'postal_code_too_long' });
  }

  // 格式（40002，表单可修正）
  if (!ASCII_RE.test(input.recipient)) throw new AppError(40002, { field: 'recipient' });
  if (!ASCII_RE.test(input.line1)) throw new AppError(40002, { field: 'line1' });
  if (input.line2 !== null && !ASCII_OR_EMPTY_RE.test(input.line2)) {
    throw new AppError(40002, { field: 'line2' });
  }
  if (!ASCII_RE.test(input.city)) throw new AppError(40002, { field: 'city' });
  if (!PHONE_RE.test(input.phone)) throw new AppError(40002, { field: 'phone' });
  if (!/^[A-Z]{2}$/.test(input.state)) throw new AppError(40002, { field: 'state' });
  if (!POSTAL_RE.test(input.postal_code)) throw new AppError(40002, { field: 'postal_code' });

  return input;
}
