/**
 * 职责：美国收货地址的州码白名单（剩余清单 4-5 / A27 / C05）——服务端校验与小程序下拉的单一来源。
 *
 * @measured(pe.usps.com/text/pub28/28apb.htm, 2026-10-06)：USPS Publication 28 附录 B「State/Possession Abbreviations」
 *   共 62 条：50 州 + DC + 属地 / 自由联系国 8 条（AS 美属萨摩亚、FM 密克罗尼西亚联邦、GU 关岛、MH 马绍尔群岛、
 *   MP 北马里亚纳群岛、PW 帕劳、PR 波多黎各、VI 美属维尔京群岛）+ 军邮 3 条（AA / AE / AP）。
 * @why 原先只校验"两位大写字母"：`XX`、`ZZ` 都能通过，标签打出去才发现是错的州——承运商退件，钱货两失。
 * @why 照抄 USPS 全表（含属地与军邮）而不是只放 50 州：地址合不合法是 USPS 的事实，能不能发、运费关税怎么算是另一回事
 *      （由 country_profiles / 运费表决定，不在这里混一层业务判断）。
 * @limitation 属地与军邮的运费、关税口径可能不同于本土（承运商与 Zonos 报价未核实，E12）；
 *             这里只保证"州码真实存在"，不保证"能按本土价发过去"。
 * @limitation 小程序端有一份副本（miniprogram/utils/us-states.js），由其单测与本表逐条比对。
 */
export const US_STATES = [
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
] as const;

const CODES: ReadonlySet<string> = new Set(US_STATES.map((s) => s.code));

export function isUsStateCode(v: unknown): boolean {
  return typeof v === 'string' && CODES.has(v);
}

/**
 * 邮编首位数字（USPS 国家分区）→ 可能的州（全入口点击测试 2026-10-11：由小程序挪来，后台改址也用）。
 * @why 只用来拦"明显选错 / 写错州"：小程序州下拉误选成 NV、邮编是纽约的 10013，面单会印成 "New York, NV, 10013"；
 *      后台改址的州是文本框，NY 手滑成 NV 同理。
 * @measured 2026-10-11 网页检索（zip-codes.com / USPS 分区表）：0 = CT MA ME NH NJ NY(仅 Fishers Island) PR RI VT VI + 军邮 AE；
 *           8 = AZ CO ID NM NV UT WY；与下表一致。
 * @limitation 例外只照顾已知的几处（纽约 06390 / 00501、得州 El Paso 885xx、华盛顿特区 569xx）；
 *             宁可少拦——表里多放一个州只是漏拦一种写错，少放一个就是合法地址存不上。
 *             小程序运行时引不了本包，留了一份副本（miniprogram/utils/address-form.js），由单测逐项比对。
 */
export const ZIP_AREA_STATES: ReadonlyArray<ReadonlyArray<string>> = [
  ['CT', 'MA', 'ME', 'NH', 'NJ', 'NY', 'PR', 'RI', 'VT', 'VI', 'AE'],
  ['DE', 'NY', 'PA'],
  ['DC', 'MD', 'NC', 'SC', 'VA', 'WV'],
  ['AL', 'FL', 'GA', 'MS', 'TN', 'AA'],
  ['IN', 'KY', 'MI', 'OH'],
  ['IA', 'MN', 'MT', 'ND', 'SD', 'WI', 'DC'],
  ['IL', 'KS', 'MO', 'NE'],
  ['AR', 'LA', 'OK', 'TX'],
  ['AZ', 'CO', 'ID', 'NM', 'NV', 'UT', 'WY', 'TX'],
  ['AK', 'CA', 'HI', 'OR', 'WA', 'AS', 'GU', 'MP', 'MH', 'FM', 'PW', 'AP'],
];

/** 邮编与州对得上吗（只看首位数字）。邮编或州形状不对时返回 true——那由各自的格式校验去报。 */
export function zipMatchesState(zip: unknown, state: unknown): boolean {
  const d = /^(\d)\d{4}(-\d{4})?$/.exec(String(zip).trim());
  const st = String(state).trim().toUpperCase();
  if (d === null || !isUsStateCode(st)) return true;
  return (ZIP_AREA_STATES[Number(d[1])] ?? []).includes(st);
}
