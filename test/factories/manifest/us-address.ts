/**
 * 职责：**美国收件地址**的真实形态清单（首个接入 `engine.ts` 的 fixture 域）。
 *
 * @why 本域此前就是"维度缺失"的活标本：数据里全是本土 48 州 + 5 位邮编 + 无符号姓名，
 *      于是"运费按同一张表算""邮编只有 5 位""州码只有 50 个"这些**假设看起来全都成立**——
 *      它们不是被验证过的，只是没有被任何一条数据戳破。
 *      真正的收件形态（军邮、属地、PO Box、夏威夷/阿拉斯加）补进来之后，
 *      FX5 才暴露出"州码白名单会误杀军邮码"这种一直存在、从没报错的问题。
 *
 * @how 清单只写**形态**（真实世界里是什么样），不写具体数值。
 *      具体数值在 `../catalog.ts`（那里有 @limitation 标注哪些是占位估计值）。
 *      两边分开是为了让"维度"和"数值"可以各自演进——数值换了（真实报价到手）
 *      不该要求重审维度清单。
 *
 * @limitation 一（重要）：这份清单**来自领域知识，不是机器核实过的**。
 *      USPS 的收件格式是公开常识，但"还有没有别的形态"这件事没有权威清单可对照——
 *      比如乡村路线（RR 2 Box 45）、酒店代收、大学宿舍、监狱信箱，目前**都没登记**。
 *      所以本文件的作用是"已想到的不许丢"，不是"想全了"。
 * @limitation 二：`coverage: string`（n/a）的条目必须写原因，引擎会检查。
 *      目前只有一条 n/a：line2 打到长度上限——那条边界值是机械填充的，
 *      不真实，刻意不进随机池（否则会污染"假数据像真的"这条要求），
 *      由 `LINE2_AT_LIMIT` / `LINE2_OVER_LIMIT` 在 `addresses.db.test.ts` 里单独覆盖。
 *
 * @see ../catalog.ts（样本数据）；../addresses.db.test.ts（真库正反例）；CLAUDE.md H2
 */
import type { AddressSeed, InvalidAddressCase } from '../catalog.js';

/** 美国地址在真实世界里的形态清单。新增形态时先写这里，再补样本——顺序不能反。 */
export const US_ADDRESS_SHAPES: readonly {
  id: string;
  why: string;
  coverage: true | string;
  matches: (a: AddressSeed) => boolean;
}[] = [
  {
    id: 'contiguous-48',
    why: '绝大多数订单落在本土 48 州；它是运费、时效的默认口径',
    coverage: true,
    matches: (a) =>
      !['AK', 'HI', 'AA', 'AE', 'AP'].includes(a.state) &&
      !['PR', 'VI', 'GU', 'AS', 'MP'].includes(a.state),
  },
  {
    id: 'zip5',
    why: '邮编只有 5 位是最常见形态；新英格兰邮编以 0 开头（02108），前端用数字承载会被吃掉前导零',
    coverage: true,
    matches: (a) => /^\d{5}$/.test(a.postalCode),
  },
  {
    id: 'zip-plus4',
    why: 'ZIP+4 约占真实投递的相当比例，且 DB CHECK 的可选后缀分支只有它能覆盖',
    coverage: true,
    matches: (a) => /^\d{5}-\d{4}$/.test(a.postalCode),
  },
  {
    id: 'zip-leading-zero',
    why: '02108 这类以 0 开头的邮编，是"数字类型吃掉前导零"这一整类 bug 的唯一触发条件',
    coverage: true,
    matches: (a) => /^0\d{4}/.test(a.postalCode),
  },
  {
    id: 'secondary-unit',
    why: '公寓/办公室地址带 Apt / Unit / Ste / Suite / Floor，面单与可达性校验都要处理二级地址',
    coverage: true,
    matches: (a) => /\b(Apt|Unit|Ste|Suite|Floor|Fl|Rm|#)\b/i.test(`${a.line1} ${a.line2 ?? ''}`),
  },
  {
    id: 'line2-absent',
    why: '相当比例的地址没有二级行；line2 为 null 与为 "" 是两回事，两种都要能落库',
    coverage: true,
    matches: (a) => a.line2 === null,
  },
  {
    id: 'apostrophe-name',
    why: "O'Brien 这类姓名含撇号；ASCII 校验不等于要清洗标点，被「清洗」掉撇号后姓名与证件不符",
    coverage: true,
    matches: (a) => a.recipient.includes("'"),
  },
  {
    id: 'company-recipient',
    why: '收件人是公司/机构名（报关与签收人不同的场景很常见），不是自然人姓名',
    coverage: true,
    matches: (a) => /\b(LLC|Inc|Corp|Co|Ltd|GmbH|K\.?K\.?|Trading|Logistics)\b/i.test(a.recipient),
  },
  {
    id: 'po-box',
    why: 'PO Box 没有街道号；部分需签收货件不送 PO Box，是可达性校验的钩子',
    coverage: true,
    matches: (a) => /^P\.?\s*O\.?\s*Box/i.test(a.line1),
  },
  {
    id: 'apo-ae',
    why: '军邮 APO + 州码 AE（Europe/Middle East）；USPS 合法收件码，不是州',
    coverage: true,
    matches: (a) => a.city === 'APO' && a.state === 'AE',
  },
  {
    id: 'fpo-ap',
    why: '军邮 FPO + 州码 AP（Pacific，如驻日基地）；与 APO/AE 是不同的州码+城市组合',
    coverage: true,
    matches: (a) => a.city === 'FPO' && a.state === 'AP',
  },
  {
    id: 'dpo-aa',
    why: '军邮 DPO + 州码 AA（Americas）；三种军邮码各有一种，缺任何一种都算覆盖不全',
    coverage: true,
    matches: (a) => a.city === 'DPO' && a.state === 'AA',
  },
  {
    id: 'hawaii',
    why: '夏威夷不在本土 48 州的运费区间内（SHIPPING_TIERS 目前不分区，按本土价报）',
    coverage: true,
    matches: (a) => a.state === 'HI',
  },
  {
    id: 'alaska',
    why: '阿拉斯加同夏威夷，且部分承运商对 AK 有单独的时效与可达性限制',
    coverage: true,
    matches: (a) => a.state === 'AK',
  },
  {
    id: 'territory',
    why: '波多黎各/关岛等属地（PR/VI/GU/AS/MP）是 USPS 合法收件目的地，清关口径与本土不同',
    coverage: true,
    matches: (a) => ['PR', 'VI', 'GU', 'AS', 'MP'].includes(a.state),
  },
  {
    id: 'line2-at-limit',
    why: 'line2 打到 VARCHAR(200) 上限',
    // ⚠️ 刻意不进随机池：那段文本是机械填充的，不真实，放进去会污染"假数据像真的"。
    //    它由 LINE2_AT_LIMIT / LINE2_OVER_LIMIT 在 addresses.db.test.ts 里单独覆盖。
    coverage: '不进随机池（机械填充不真实），由 LINE2_AT_LIMIT / LINE2_OVER_LIMIT 单独覆盖',
    matches: (a) => (a.line2 ?? '').length > 150,
  },
];

/** 脏输入形态清单（真实用户会填成什么样）。 */
export const US_ADDRESS_DIRTY_SHAPES: readonly {
  id: string;
  why: string;
  coverage: true | string;
  matches: (c: InvalidAddressCase) => boolean;
}[] = [
  {
    id: 'dirty-recipient-nonascii',
    why: '买家用微信地址簿导入，收件人常是中文名；DB 的 recipient CHECK 要求 ASCII',
    coverage: true,
    matches: (c) => c.name === '收件人含中文',
  },
  {
    id: 'dirty-phone-formatted',
    why: '美国用户最常填的形态就是带连字符的本土号码，不是 E.164',
    coverage: true,
    matches: (c) => c.name === '电话填成 212-555-0000（带连字符、缺 +1）',
  },
  {
    id: 'dirty-zip-short',
    why: '新英格兰邮编以 0 开头，前端若用数字类型承载会被吃掉前导零 → 变成 4 位',
    coverage: true,
    matches: (c) => c.name === '邮编只有 4 位',
  },
  {
    id: 'dirty-zip-space',
    why: '手打邮编时最爱用空格分隔（94108 4567），正好 10 字符、能到达格式校验',
    coverage: true,
    matches: (c) => c.name === 'ZIP+4 用空格代替连字符',
  },
  {
    id: 'dirty-line1-nonascii',
    why: '与收件人同理，街道也常是中文',
    coverage: true,
    matches: (c) => c.name === 'line1 含中文',
  },
  {
    id: 'dirty-line2-over-limit',
    why: '备注栏让用户写配送指示容易写满；VARCHAR 超限是 SQLSTATE 22001，不是 CHECK',
    coverage: true,
    matches: (c) => c.name.startsWith('line2 超过'),
  },
  {
    id: 'dirty-state-invalid',
    why: '州码写成 ZZ 目前**能入库**（state/country 在 DB 层无 CHECK，见 F-A1）',
    // ⚠️ 刻意标 n/a：这条不是"数据被拒绝"，而是**已知缺口**，
    //    由 addresses.db.test.ts 里那条"已知缺口的表征测试"专门守着。
    //    放进来会让"每条反例都必须被拒"这条断言失真。
    coverage: '不是被拒的反例，而是已知缺口（F-A1），由专门的表征测试覆盖',
    matches: (c) => c.name.includes('州码'),
  },
];
