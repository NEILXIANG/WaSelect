/**
 * 职责：假数据的**素材库**（F9-b）——真实感来自这里，而不是随机数。
 *
 * @why 用 `string(10)` 造出来的假数据有一条致命问题：它**绕过了所有真实约束**。
 *      美国收件人姓名如果随机生成了日文，DB 的 `recipient ~ '^[ -~]+$'` 会拒，
 *      但更危险的是"不拒"的场景——比如重量分布全是 100g，运费永远落在最低档，
 *      于是取档逻辑的边界 bug 一条也测不出来。素材必须来自真实分布。
 *
 * 本文件只放**常量素材**，不含随机逻辑（随机在 entities.ts，用 rng.ts 的确定性随机源）。
 *
 * @limitation 一：**价格、重量、JAN 码是占位估计值**，不是真实采购价。
 *      来源：公开零售价的量级估计 + 经验值。换成真实数据前，
 *      任何基于本表做出的"净贡献率 / 上架红线"结论都不可用于决策。
 * @limitation 二：**运费阶梯是占位**（锚点 2kg = 4,950 円，来自 30-商业模式/商业测算模型.xlsx）。
 *      真实报价须询転送コム / EMS / 佐川后整体替换——替换后 `w=1850 → 4950` 这条红线向量会变，
 *      必须同步改 `docs/` 与测试里的期望值（那里有注释指向这里）。
 * @limitation 三：商品清单只覆盖 MVP 的三类（美妆 / 厨具 / 保温杯）+ 若干长尾，
 *      不含"液体 / 含酒精 / 管制刀具"等需要额外合规判断的品类——
 *      这些品类的合规规则尚未定（R1 相关），先不进假数据，免得长出假的安全感。
 *
 * @limitation 四（⚠️ 已知缺口，不是期望行为）：`addresses.state` 与 `country` 在 DB 层**没有任何 CHECK**——
 *      `state` 能写 'ZZ'、'  '，`country` 能写 'XX'。按 ADR-28「多国家由配置驱动、不发版」，
 *      不该在 DB 层硬编码国家/州白名单；但**应用层校验目前不存在**，
 *      于是"一条假地址能安静入库"。修的位置是地址校验单元（业务期，按 country 取配置校验），
 *      不是这里。相关回归样本已备好：军邮州码 AA/AE/AP 三条在 `US_ADDRESSES` 里。
 *
 * @see migrations/001_init.sql（CHECK 约束是本文件的硬边界）；docs/地基搭建清单.md F9
 */

/** 商品素材。weight_g 含包装前的实重（包材另计，见订单工厂）。 */
/**
 * 商品类目。**逐字取自 api-contract.yaml 的枚举** `[beauty, daily, kitchen, food]`。
 * @why 曾经用过 `lifestyle`——它不在契约枚举里，于是假数据造出来的商品
 *      根本不可能通过上架校验。用"不可能存在的商品"测出来的绿灯是假的。
 * @see contracts/api-contract.yaml（ProductInput.category）
 */
export type ContractCategory = 'beauty' | 'daily' | 'kitchen' | 'food';

export interface ProductSeed {
  /** 日文原名（真实商品名，用于校验日文渲染与搜索） */
  titleJa: string;
  /** 面向买家的标题（中文，MVP 面向中文用户） */
  title: string;
  /** 类目必须取自契约枚举；此处用字面量联合类型，写错在编译期报错。 */
  category: ContractCategory;
  /** 实重（克），不含包材 */
  weightG: number;
  /** 日本零售价（円），占位估计值——见 @limitation 一 */
  priceJpy: number;
  /** JAN 码（13 位）；部分商品无码，置空以覆盖"没有条码"的真实情况 */
  janCode: string | null;
  hsCode: string;
  customsDescEn: string;
  purchaseSource: string;
  /**
   * 编辑口径的"为什么值得买"（`products.why`，020 迁移新增）。
   *
   * @why 假数据里**必须有真 why**：`pick-card` 的版式是"图在上、why 在中、价在下"，
   *      没有 why 时它退化成一张普通商品卡——于是"S4 迁完 pick-card"这件事
   *      看上去完成了，实际什么也没验证到。这与 @limitation 一（价格是占位）
   *      **不同**：价格影响的是"能不能算对"，why 影响的是"版式成不成立"，
   *      而占位文案（"高品质"）测出来的正是设计侧点名的**退化形态**。
   * @why 每一条都写成"**一句带判断的话**"（有因果、有比较对象），不写形容词罗列：
   *      用户旅程地图里"停留 → 读 why → 判定是不是话术"是 A 旅程的关键转化点，
   *      假数据若写成"匠心工艺"，整条链路练的都是错的。
   */
  why: string;
  /** 产地 / 工房 / 匠人署名（`products.maker`）。留空串 = 不署名（可选列的空态）。 */
  maker: string;
  /** 编辑展示标签（`products.tags`）。⚠️ 与 `compliance_tags`（能不能寄）分工不同。 */
  tags: readonly string[];
}

/**
 * 日本直邮常见商品（MVP 三类 + 长尾）。
 * @why 清单里刻意混入"重量跨档"的商品：180g 的护手霜与 1,200g 的日本酒+包材会落到不同运费档，
 *      这样运费取档的边界用例不用另外造数据。
 */
export const JP_PRODUCTS: readonly ProductSeed[] = [
  {
    titleJa: 'SK-II フェイシャルトリートメントエッセンス 230mL',
    title: 'SK-II 护肤精华露 230mL',
    category: 'beauty',
    weightG: 620,
    priceJpy: 25300,
    janCode: '4979006001234',
    hsCode: '3304.99',
    customsDescEn: 'Facial treatment essence, 230mL',
    why: '这瓶水的成分表二十年没变过，PITERA 的含量也只有原厂这一个规格——代购价差那一截，买的是真假。',
    maker: '滋贺 · 原厂规格',
    tags: ['正规格', '含税直邮'],
    purchaseSource: '松本清 免税店',
  },
  // ⚠️ 原为某品牌「乳液」——该类商品在日本**可能是医薬部外品**，而 `quasi_drug`
  // 同样属于上架即拒的标签。我无法核实具体 SKU 的法定区分，因此换成口径明确的一般化妆品，
  // 不在无法核实的事情上赌一把（真实 SKU 上架前仍须逐个核对 compliance_tags，见下方 @warning）
  {
    titleJa: '無印良品 化粧水・敏感肌用 200mL',
    title: '无印良品 化妆水·敏感肌用 200mL',
    category: 'beauty',
    weightG: 240,
    priceJpy: 1290,
    janCode: '4901872088412',
    hsCode: '3304.99',
    customsDescEn: 'Skin lotion for sensitive skin, 200mL',
    why: '无印这条线把香精、色素、酒精全去掉了，敏感肌能用的化妆水里它是最不挑人的一瓶；200mL 刚好是一个月的量。',
    maker: '無印良品 · 大阪',
    tags: ['无香精', '敏感肌可用'],
    purchaseSource: '無印良品',
  },
  {
    titleJa: '膳 三徳包丁 165mm（VG10 鋼）',
    title: '日本制 三德刀 165mm（VG10 钢）',
    category: 'kitchen',
    weightG: 340,
    priceJpy: 12800,
    janCode: null, // 手作厨具常无 JAN 码——刻意保留，覆盖"无码商品"分支
    hsCode: '8211.10',
    customsDescEn: 'Kitchen knife, blade 165mm',
    why: 'VG10 夹钢的好处是刃口能磨得很薄又不崩，代价是不能砍骨头——三德刀本来就是切菜刀，165mm 是单手最好控的长度。',
    maker: '合羽橋 · 堺刀司',
    tags: ['VG10 夹钢', '可重磨'],
    purchaseSource: '合羽橋 道具街',
  },
  {
    titleJa: 'サーモス 真空断熱ケータイマグ 500mL',
    title: '膳魔师 保温杯 500mL',
    category: 'daily',
    weightG: 300,
    priceJpy: 4500,
    janCode: '4971878012345',
    hsCode: '9617.00',
    customsDescEn: 'Vacuum insulated tumbler, 500mL',
    why: '膳魔师的真空层做到了 0.1mm 以下，所以 500mL 的杯子只有 200g 出头——同样 6 小时保温，它比同容量的国产款轻一半。',
    maker: '膳魔师 · 新潟',
    tags: ['6 小时保温', '轻量'],
    purchaseSource: 'ビックカメラ',
  },
  {
    titleJa: '南部鉄器 急須 0.6L',
    title: '南部铁器 铁壶 0.6L',
    category: 'kitchen',
    weightG: 1350,
    priceJpy: 16000,
    janCode: null,
    hsCode: '7323.93',
    customsDescEn: 'Cast iron teapot, 0.6L',
    why: '铸铁壶烧水会溶出二价铁，泡老茶时水温掉得慢；但内壁有氧化膜、不能干烧——这一条比「能补铁」重要得多。',
    maker: '岩手 · 南部铁器 伝統工芸士',
    tags: ['产地直送', '终身可用'],
    purchaseSource: '岩手 直送',
  },
  // ⚠️ 这里原本放的是獺祭清酒——**违反契约**：`compliance_tags` 含 `alcohol` 者
  // 「需酒类免许且不可邮寄」，在 D-51 口径下上架即拒。用一条永远上不了架的 SKU 做假数据，
  // 等于拿"不可能发生的订单"去测业务规则。换成同为食品、但合规的抹茶粉。
  {
    titleJa: '京都 宇治抹茶 粉末 100g',
    title: '京都宇治抹茶粉 100g',
    category: 'food',
    weightG: 130,
    priceJpy: 2380,
    janCode: '4973157001234',
    hsCode: '0902.10',
    customsDescEn: 'Green tea powder (matcha), 100g',
    why: '宇治抹茶的鲜味来自覆下栽培，摘后四小时内必须蒸青——过了这个窗口就只剩苦。100g 是两个月喝完的量，再大就氧化了。',
    maker: '京都 · 宇治 茶舗',
    tags: ['覆下栽培', '当季新茶'],
    purchaseSource: '京都 茶舗',
  },
  {
    titleJa: '東京ばな奈「見ぃつけたっ」8個入',
    title: '东京香蕉蛋糕 8 个装',
    category: 'food',
    weightG: 520,
    priceJpy: 1400,
    janCode: '4901351005678',
    hsCode: '1905.90',
    customsDescEn: 'Confectionery, 8 pieces',
    why: '东京站限定，保质期只有 7 天，所以代购拿到手的常常已经是第五六天——直邮的意义在这里，不在价格。',
    maker: '東京駅 · 土産店',
    tags: ['车站限定', '短保'],
    purchaseSource: '東京駅 土産店',
  },
  // ── 下面两条刻意补足重货：只有轻货的话，运费取档的"高档位"和"超重"分支永远没数据可用 ──
  {
    titleJa: '南部鉄器 中華鍋 30cm',
    title: '南部铁器 中式炒锅 30cm',
    category: 'kitchen',
    weightG: 2380,
    priceJpy: 9800,
    janCode: null,
    hsCode: '7323.93',
    customsDescEn: 'Cast iron wok, 30cm',
    why: '2.4kg 的铁锅预热慢，但一旦热起来就不降温——中式爆炒要的就是这个蓄热，不粘锅给不了。',
    maker: '岩手 · 南部铁器 伝統工芸士',
    tags: ['产地直送', '无涂层'],
    purchaseSource: '岩手 直送',
  },
  {
    titleJa: '新潟産コシヒカリ 無洗米 5kg',
    title: '新潟产越光免洗米 5kg',
    category: 'food',
    weightG: 5100,
    priceJpy: 2800,
    janCode: '4901234567890',
    hsCode: '1006.30',
    customsDescEn: 'Semi-milled rice, 5kg',
    why: '免洗米在工厂里就把米糠磨掉了，淘米时不用再搓——代价是香味略薄，换来的五分钟是每天的。',
    maker: '新潟 · JA 直送',
    tags: ['免洗', '当年新米'],
    purchaseSource: '新潟 JA',
  },
  {
    titleJa: '無印良品 ゲルインクボールペン 0.5mm 5本組',
    title: '无印良品 中性笔 0.5mm 5 支装',
    category: 'daily',
    weightG: 60,
    priceJpy: 550,
    janCode: '4547315001234',
    hsCode: '9608.10',
    customsDescEn: 'Ball point pens, 5 pieces',
    why: '0.5mm 凝胶笔里它最不容易断墨，五支装折下来一支两块多——这个价位谈「手感」是虚的，不断墨才是真需求。',
    maker: '無印良品 · 大阪',
    tags: ['不易断墨', '5 支装'],
    purchaseSource: '無印良品',
  },
];

/**
 * 运费阶梯。
 *
 * @why **这张表是唯一数据源，逐条来自《技术文档》§2.5**（非估算）。
 *      曾经这里放着一套自造的中间档（500→1980、1000→2750……），与技术文档的回归红线 **5/7 不符**，
 *      而且错误值被自己的单测写成了断言——相当于把"编出来的数字"固化成"必须满足的规则"，
 *      真报价到位时这条测试会从护栏变成拦路石。现在改成直接照抄文档口径，并给每条标注来源。
 *
 * @limitation 一：**价格仍是占位**（锚点 `転送コム 2kg ≈ 4,950 円`，来自 30-商业模式/商业测算模型.xlsx）。
 *              `source='fabricated'` 的两档是为了让假数据能有重货，**仅存在于均匀区之上**
 *              （有测试保证它们影响不到任何一条红线向量）。真实报价到手后整体替换，并同步三处：
 *              本文件、技术文档 §2.5 的 7 条向量、任务看板 R22。
 * @limitation 二：`maxWeightG=3000` 那一档的**价格 6600 来自文档**（`w=2001→6600` 的期望值），
 *              但它的**上限重量文档没给**，是为补齐形状取的 3000——略偏保守（≥2001 且 <3000 的包裹按 6600 收）。
 * @see jp/50-产品与技术/技术架构/技术文档.md §2.5（D-46 / R22 红线向量）
 */
export interface ShippingTier {
  maxWeightG: number;
  priceJpy: number;
  /** `doc` = 技术文档来源；`fabricated` = 为保证假数据有重货而估算，禁止进入红线区（有测试约束）。 */
  source: 'doc' | 'fabricated';
}

/** 锚点：技術文档 §2.5 与商业测算模型共用的 2kg = 4,950 円。 */
export const SHIPPING_TIER_ANCHOR = { maxWeightG: 2000, priceJpy: 4950 } as const;

/** 技术文档口径的最大包裹重量：此范围内的档必须全部有文档来源（见 @limitation 一）。 */
export const REDLINE_MAX_WEIGHT_G = 3000;

export const SHIPPING_TIERS: readonly ShippingTier[] = [
  { maxWeightG: 100, priceJpy: 1400, source: 'doc' },
  { maxWeightG: 250, priceJpy: 1650, source: 'doc' },
  { maxWeightG: 500, priceJpy: 2150, source: 'doc' },
  { maxWeightG: 1000, priceJpy: 3150, source: 'doc' },
  { maxWeightG: 1500, priceJpy: 4050, source: 'doc' },
  { maxWeightG: 2000, priceJpy: 4950, source: 'doc' },
  { maxWeightG: 3000, priceJpy: 6600, source: 'doc' },
  // ── 以下为估算：仅为让 fixtur 里有 ≥3kg 的重货，真实报价到位后立即替换 ──
  { maxWeightG: 5000, priceJpy: 9200, source: 'fabricated' },
  { maxWeightG: 10000, priceJpy: 14000, source: 'fabricated' },
];

/**
 * 运费取档：第一个 `max_weight_g >= 重量` 的档（向上取档）。超重返回 null。
 * @see 同 ADR 级约束见《代码注释规范与日志体系设计》与技术文档 §2.5 的唯一正确 SQL 写法
 */
export function pickTier(weightG: number): ShippingTier | null {
  return SHIPPING_TIERS.find((t) => t.maxWeightG >= weightG) ?? null;
}

/** 美国收件地址素材。收件人/街道/城市必须是 ASCII（DB CHECK `^[ -~]+$`）。 */
export interface AddressSeed {
  recipient: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  /** 州对应的区号（电话需满足 CHECK `^\+1[0-9]{10}$`） */
  areaCode: string;
}

/**
 * @why 前 9 条是"普通本土地址"，后 6 条是**边界样本**（FX5）。
 *      它们共用同一个池子是有意的：`makeAddress()` 随机取一条，
 *      于是"连插 100 条"这种用例会顺带扫到军邮与外岛，
 *      不需要每个用例都记得单独造边界数据。
 *
 *      ⚠️ 缺边界样本的代价是**静默的**：全是"本土 48 州 + 5 位邮编 + 无符号姓名"的数据，
 *      会让"运费按同一张表算""邮编只有 5 位"这类假设看起来成立，
 *      等真实订单出现 APO / 夏威夷时才发现报价与可达性都不对。
 */
export const US_ADDRESSES: readonly AddressSeed[] = [
  {
    recipient: 'Zhang Wei',
    line1: '350 5th Ave Apt 12B',
    line2: null,
    city: 'New York',
    state: 'NY',
    postalCode: '10118',
    areaCode: '212',
  },
  {
    recipient: 'Li Na',
    line1: '1234 Wilshire Blvd Unit 305',
    line2: 'Floor 3',
    city: 'Los Angeles',
    state: 'CA',
    postalCode: '90017',
    areaCode: '213',
  },
  {
    recipient: 'Chen Hao',
    line1: '233 S Wacker Dr Ste 800',
    line2: null,
    city: 'Chicago',
    state: 'IL',
    postalCode: '60606',
    areaCode: '312',
  },
  {
    recipient: 'Wang Fang',
    line1: '1201 Louisiana St',
    line2: 'Apt 2204',
    city: 'Houston',
    state: 'TX',
    postalCode: '77002',
    areaCode: '713',
  },
  {
    recipient: 'Liu Yang',
    line1: '600 4th Ave',
    line2: null,
    city: 'Seattle',
    state: 'WA',
    postalCode: '98104',
    areaCode: '206',
  },
  {
    recipient: 'Zhao Min',
    line1: '200 NE 1st St',
    line2: 'Unit 15',
    city: 'Miami',
    state: 'FL',
    postalCode: '33132',
    areaCode: '305',
  },
  {
    recipient: 'Sun Qi',
    line1: '1 Beacon St',
    line2: null,
    city: 'Boston',
    state: 'MA',
    postalCode: '02108',
    areaCode: '617',
  },
  {
    recipient: 'Zhou Lei',
    line1: '1601 Larimer St',
    line2: 'Apt 907',
    city: 'Denver',
    state: 'CO',
    postalCode: '80202',
    areaCode: '303',
  },
  // 刻意包含 ZIP+4 形态：覆盖 postal_code CHECK 的可选后缀分支
  {
    recipient: 'Wu Jing',
    line1: '88 Kearny St',
    line2: null,
    city: 'San Francisco',
    state: 'CA',
    postalCode: '94108-4567',
    areaCode: '415',
  },

  // ─────────────── 以下为 FX5 边界样本（都是现实里真实存在的收件形态）───────────────

  // ① 姓名含撇号。`recipient` 的 CHECK 是 `^[ -~]+$`，撇号（0x27）在区间内——
  //    它常被误当成"需要转义/会被过滤"的字符，于是姓名在入库时被改成 OBrien，
  //    收件人姓名与证件不符。留这条是为了钉住"ASCII 校验不等于要清洗标点"。
  {
    recipient: "Sean O'Brien",
    line1: '89 Broad St',
    line2: 'Apt 4R',
    city: 'Boston',
    state: 'MA',
    postalCode: '02110',
    areaCode: '617',
  },

  // ② 军邮（APO / FPO / DPO）。州码是 **AA / AE / AP**（军邮州码，不是真实州）：
  //    AA=Americas、AE=Europe/Middle East、AP=Pacific。city 必须是 APO/FPO/DPO 之一。
  //    ⚠️ 这三个州码最容易被"州码白名单"误杀——本表 `state` 在 DB 层没有 CHECK（见 @limitation 四），
  //    所以现在不会被拦；将来应用层加州码校验时，这三条就是回归样本。
  {
    recipient: 'CPT J. Rivera',
    line1: 'PSC 4512 Box 7300',
    line2: null,
    city: 'APO',
    state: 'AE',
    postalCode: '09123-7300',
    areaCode: '212',
  },
  {
    recipient: 'SFC K. Tanaka',
    line1: 'PSC 476 Box 1234',
    line2: null,
    city: 'FPO',
    state: 'AP',
    postalCode: '96322-1234',
    areaCode: '808',
  },
  {
    recipient: 'SSG M. Alvarez',
    line1: 'Unit 5000 Box 12',
    line2: null,
    city: 'DPO',
    state: 'AA',
    postalCode: '34035',
    areaCode: '305',
  },

  // ③ PO Box：line1 是 "PO Box N"，**没有街道号**。
  //    真实约束：部分承运商（需签收货件）不送 PO Box——这条样本是给"可达性校验"留的钩子。
  {
    recipient: 'Grace Nakamura',
    line1: 'PO Box 1071',
    line2: null,
    city: 'Portland',
    state: 'OR',
    postalCode: '97207',
    areaCode: '503',
  },

  // ④⑤ 夏威夷 / 阿拉斯加：邮编 967xx / 995xx，且**不在本土 48 州的运费区间内**
  //    （见 SHIPPING_TIERS 的 @limitation——同一张表不区分目的地，这两个州会被按本土价报价）。
  {
    recipient: 'Keoni Akana',
    line1: '1159 Nuuanu Ave',
    line2: 'Apt 1802',
    city: 'Honolulu',
    state: 'HI',
    postalCode: '96817',
    areaCode: '808',
  },
  {
    recipient: 'Maya Kowalski',
    line1: '400 D St',
    line2: 'Suite 210',
    city: 'Anchorage',
    state: 'AK',
    postalCode: '99501',
    areaCode: '907',
  },
  {
    // ⑥ 收件人是公司/机构名：报关口径与"自然人自用"不同，签收主体也不是个人。
    //    这条是 `test/factories/manifest/us-address.ts` 建清单时**先判红、再补进来**的——
    //    清单的价值就在这里：没有清单时，没人会意识到样本里缺了一整类收件人。
    recipient: 'Sakura Trading LLC',
    line1: '2101 L St NW',
    line2: 'Suite 800',
    city: 'Washington',
    state: 'DC',
    postalCode: '20037',
    areaCode: '202',
  },
  {
    // ⑦ 属地（波多黎各）：USPS 合法收件目的地，州码 PR 不在 50 州里，清关口径与本土不同。
    //    同上，是形态清单判红后补进来的。
    recipient: 'Carlos Ruiz',
    line1: '1451 Ashford Ave',
    line2: 'Apt 12C',
    city: 'San Juan',
    state: 'PR',
    postalCode: '00907',
    areaCode: '787',
  },
];

/** 生成一个满足 `^\+1[0-9]{10}$` 的电话。区号取自素材，后 7 位来自传入的随机源。 */
export function formatUsPhone(areaCode: string, sevenDigits: number): string {
  const tail = String(sevenDigits).padStart(7, '0').slice(-7);
  return `+1${areaCode}${tail}`;
}

/**
 * `line2` 的 DDL 长度上限（VARCHAR(200)）。
 * @why 这个数字**必须与 DDL 一致**，但 TS 里没法从 SQL 推导，所以由 db 测试反向断言
 *      （查 `information_schema.columns` 比对）——DDL 一改，那条测试立刻红，
 *      不会出现"字段扩到 300 了、假数据还在测 200"这种脱节。
 */
export const ADDRESS_LINE2_MAX_CHARS = 200;

/**
 * 造一段**恰好 n 字符**的 line2。
 * @limitation 前缀之后是机械填充，不是真实地址文本——这里被测的是**长度边界**，
 *             不是真实感；真实感由 `US_ADDRESSES` 里的样本负责。别把这个函数
 *             拿去生成随机池里的地址（会污染"假数据像真的"这条要求）。
 */
export function makeLongLine2(chars: number): string {
  const prefix = 'C/O Receiving Dept, ';
  const filler = 'Bldg 27 Dock 4, ';
  let s = prefix;
  while (s.length + filler.length <= chars) s += filler;
  if (s.length < chars) s += 'X'.repeat(chars - s.length);
  return s.slice(0, chars);
}

/** 恰好在上限的 line2（应能入库）。 */
export const LINE2_AT_LIMIT = makeLongLine2(ADDRESS_LINE2_MAX_CHARS);
/** 超出上限 1 字符的 line2（应被 22001 拒绝）。 */
export const LINE2_OVER_LIMIT = makeLongLine2(ADDRESS_LINE2_MAX_CHARS + 1);

/**
 * 地址反例（FX5）——每一条都对应一种"真实用户会填成这样"的脏输入。
 *
 * @why 只造合法样本会让人误以为 CHECK 约束在保护我们。
 *      约束是否**真的生效**，只有拿反例去撞才知道：约束名写错、字段改名后约束悬空、
 *      迁移被跳过——这些情况下"合法样本全绿"依旧全绿。
 *      所以反例与正例成对出现，数量对齐。
 */
export interface InvalidAddressCase {
  /** 反例名，测试失败时直接指出是哪一类 */
  name: string;
  /** 为什么真实世界里会出现这种输入 */
  why: string;
  /** 覆盖到合法基线上的字段（未列出的字段沿用基线） */
  patch: {
    recipient?: string;
    phone?: string;
    line1?: string;
    line2?: string | null;
    city?: string;
    state?: string;
    postal_code?: string;
  };
  /** 期望命中的约束名（超长类错误没有约束名，用 SQLSTATE 22001）；`layer: 'app'` 时是应用层的原因码 */
  expect: string;
  /**
   * 在哪一层被拒（缺省 = 数据库约束，`addresses.db.test.ts` 逐条插库验证）。
   * `'app'` = 只在应用层拦（服务端 `parseAddressInput` + 小程序 / 后台表单），数据库**刻意不设**约束：
   * 规则表是粗粒度的（只看邮编首位），且存量地址可能已不一致——上 CHECK 要先清数据、还会把规则写死进 DDL。
   */
  layer?: 'app';
}

export const US_ADDRESS_INVALID: readonly InvalidAddressCase[] = [
  {
    name: '收件人含中文',
    why: '买家用微信地址簿导入，收件人常是中文名；DB 的 recipient CHECK 要求 ASCII',
    patch: { recipient: '李雷' },
    expect: 'addresses_recipient_check',
  },
  {
    name: '电话填成 212-555-0000（带连字符、缺 +1）',
    why: '美国用户最常填的形态就是带连字符的本土号码，不是 E.164',
    patch: { phone: '212-555-0000' },
    expect: 'addresses_phone_check',
  },
  {
    name: '邮编只有 4 位',
    why: '新英格兰邮编以 0 开头（02108），前端若用数字类型承载会被吃掉前导零',
    patch: { postal_code: '0210' },
    expect: 'addresses_postal_code_check',
  },
  {
    // ⚠️ 这里**刻意不用** `94108-45670`（后缀写 5 位）：那是 11 字符，
    //    会先撞 `VARCHAR(10)` 的长度限制报 22001，**根本到不了格式 CHECK**——
    //    于是这条反例实际测的是长度而不是邮编格式，名不副实（我第一版就是这么写错的）。
    //    用空格代替连字符才是真实且能命中正则可选后缀分支的输入。
    name: 'ZIP+4 用空格代替连字符',
    why: '用户手打邮编时最爱用空格分隔：94108 4567（正好 10 字符，能到达格式校验）',
    patch: { postal_code: '94108 4567' },
    expect: 'addresses_postal_code_check',
  },
  {
    name: 'line1 含中文',
    why: '与收件人同理，街道也常是中文',
    patch: { line1: '南京东路 100 号' },
    expect: 'addresses_line1_check',
  },
  {
    name: `line2 超过 ${ADDRESS_LINE2_MAX_CHARS} 字符`,
    why: '备注栏让用户写配送指示，容易写满；VARCHAR 超限是 SQLSTATE 22001，不是 CHECK',
    patch: { line2: LINE2_OVER_LIMIT },
    expect: '22001',
  },
  {
    name: '邮编与州对不上（NY + 89501）',
    why: '州下拉手滑选错（NV ↔ NY 挨着）、或照抄旧地址只改了州：面单照打，承运商按邮编分拣后退件（全入口点击测试 2026-10-11 实测撞到）',
    patch: { state: 'NY', postal_code: '89501' },
    expect: 'zip_state_mismatch',
    layer: 'app',
  },
];
