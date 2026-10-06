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
