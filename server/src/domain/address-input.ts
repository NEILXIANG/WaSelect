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
 *              **40002**（格式：非 ASCII / 电话 / 邮编 / state，以及美国地址邮编与州对不上 `zip_state_mismatch`，AJ-496）。
 * @limitation 三：邮编与州只看邮编首位（shared `ZIP_AREA_STATES`，与小程序 / 后台同源）——同一首位区内选错州（NY ↔ NJ）拦不住；
 *              数据库不设对应约束（存量数据可能已不一致、规则不宜写死进 DDL），已存的地址不回头校验。
 *              区分的意义在 action：40002 是"用户改一改就能对"，40001 多半是接口用错了。
 *
 * @see contracts/api-contract.yaml（AddressInput）；app/address-routes.ts；
 *      app/admin-order-routes.ts（第二个消费方）
 */
import { AppError } from '../errors.js';
import { ADDRESS_MAX_CHARS, isUsStateCode, zipMatchesState } from '@waselect/shared';

/**
 * 列宽：真源在 shared（两端输入测试 2026-10-12 挪过去，管理端改址框的 maxLength 同引）。
 * 这里原名再导出：小程序 `utils/address-form.js` 的同名常量与它做单测比对（TST3-02）。
 */
export { ADDRESS_MAX_CHARS };
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
/**
 * 格式错（40002）：出错的字段（与可能的原因）同时进日志与对外 `data`（AJ-498）。
 * @why 原先只进日志、对外只有通用文案"地址须为英文/拼音或电话格式错误"——绕过前端（旧版本小程序、直接调接口）被拒时，
 *      用户不知道是哪一格；邮编与州对不上也被说成"须为英文"，方向是错的（业务旅程测试 2026-10-12）。
 *      字段名与原因码不含用户数据，可以对外（契约 Err.data 已有 field / reason）。
 */
function bad(field: string, reason?: string): AppError {
  const data = reason === undefined ? { field } : { field, reason };
  return new AppError(40002, data, data);
}

export function parseAddressInput(body: unknown): AddressInputValue {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object') throw new AppError(40001, { reason: 'body_shape' });

  // ⚠️ 判空用 `trim()` 而不是 `length === 0`：只判长度时，敲三个空格（或全角空格）
  //    就能通过全部校验并存进地址簿。它在保存时不报错、在地址列表里也不显得异常
  //    （就是"一行为空"），一直要到**打面单**或承运商校验那一步才炸——而那时货已在仓里。
  //    @why 只收紧"必填"这一层，不在这 trim 掉两端空格后保存：
  //    那是展示口径（`'  Jane  '` 目视无差别），一并改会牵动存量地址行的比对逻辑。
  for (const k of REQUIRED) {
    if (typeof b[k] !== 'string' || (b[k] as string).trim() === '') {
      throw new AppError(40001, { reason: `${k}_required` });
    }
  }
  const input: AddressInputValue = {
    recipient: b['recipient'] as string,
    phone: b['phone'] as string,
    line1: b['line1'] as string,
    // 空串 / 纯空白归 null（S-8 / AJ-461）：契约 0.6.65 写"没填为 null"，此前 '' 会原样入库回显
    line2:
      b['line2'] === undefined || b['line2'] === null || String(b['line2']).trim() === ''
        ? null
        : String(b['line2']),
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
  if (!ASCII_RE.test(input.recipient)) throw bad('recipient');
  if (!ASCII_RE.test(input.line1)) throw bad('line1');
  if (input.line2 !== null && !ASCII_OR_EMPTY_RE.test(input.line2)) {
    throw bad('line2');
  }
  if (!ASCII_RE.test(input.city)) throw bad('city');
  if (!PHONE_RE.test(input.phone)) throw bad('phone');
  if (!/^[A-Z]{2}$/.test(input.state)) throw bad('state');
  // 剩余清单 4-5：美国地址的州码必须真实存在（USPS Pub 28 附录 B，shared/us-states.ts）——
  //    只校验"两位大写"时 XX / ZZ 都能过，标签打出去才被承运商退件
  if (input.country === 'US' && !isUsStateCode(input.state)) {
    throw bad('state');
  }
  if (!POSTAL_RE.test(input.postal_code)) throw bad('postal_code');
  // AJ-496：邮编首位与州对不上（NY + 89501）——每个字段都合法、组合起来送不到。原先只有两个前端拦，
  //    绕过前端（旧版本小程序、直接调接口）照样入库。规则与前端同源（shared ZIP_AREA_STATES，宁可少拦）
  if (input.country === 'US' && !zipMatchesState(input.postal_code, input.state)) {
    throw bad('postal_code', 'zip_state_mismatch');
  }

  return input;
}
