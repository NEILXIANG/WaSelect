/**
 * 职责：美国州码（剩余清单 4-5）——小程序端副本 + 下拉文案 + 按代码找下标。纯数据 / 纯函数。
 *
 * @why 副本而不是 import `@waselect/shared`：小程序运行时不加载 packages/shared（只有单测能 import 它）；
 *      两份由 `us-states.unit.test.ts` 逐条比对（代码与顺序），漏一个州 = 那个州的买家选不到。
 * @why 下拉而不是手输：手输时"ca"、"Calif"、"XX"都会被敲进来，直到服务端 40002 才说不对；
 *      下拉从源头只给 USPS 真实存在的 62 个代码（来源与 @measured 见 packages/shared/src/us-states.ts）。
 * @limitation 下拉按 USPS 表的顺序（字母序为主、属地穿插其中）；不按人口排序，也不做搜索。
 */
export const US_STATE_ROWS = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AS', name: 'American Samoa' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FM', name: 'Federated States of Micronesia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'GU', name: 'Guam' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MH', name: 'Marshall Islands' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'MP', name: 'Northern Mariana Islands' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PW', name: 'Palau' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VI', name: 'Virgin Islands' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
  { code: 'AA', name: 'Armed Forces Americas' },
  { code: 'AE', name: 'Armed Forces Europe / Middle East / Canada' },
  { code: 'AP', name: 'Armed Forces Pacific' },
];

/** 下拉文案：`CA · California`。 */
export const STATE_LABELS = US_STATE_ROWS.map((r) => `${r.code} · ${r.name}`);

/** 代码 → 下拉下标（大小写不敏感）；找不到 → -1。 */
export function stateIndexOf(code) {
  if (typeof code !== 'string') return -1;
  const c = code.trim().toUpperCase();
  return US_STATE_ROWS.findIndex((r) => r.code === c);
}

/** 是否真实州码（大小写敏感：表单提交前已转大写）。 */
export function isUsStateCode(code) {
  return typeof code === 'string' && US_STATE_ROWS.some((r) => r.code === code);
}
