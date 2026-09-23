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
 * @see migrations/001_init.sql（CHECK 约束是本文件的硬边界）；docs/地基搭建清单.md F9
 */

/** 商品素材。weight_g 含包装前的实重（包材另计，见订单工厂）。 */
export interface ProductSeed {
  /** 日文原名（真实商品名，用于校验日文渲染与搜索） */
  titleJa: string;
  /** 面向买家的标题（中文，MVP 面向中文用户） */
  title: string;
  category: 'beauty' | 'kitchen' | 'lifestyle' | 'food';
  /** 实重（克），不含包材 */
  weightG: number;
  /** 日本零售价（円），占位估计值——见 @limitation 一 */
  priceJpy: number;
  /** JAN 码（13 位）；部分商品无码，置空以覆盖"没有条码"的真实情况 */
  janCode: string | null;
  hsCode: string;
  customsDescEn: string;
  purchaseSource: string;
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
    purchaseSource: '松本清 免税店',
  },
  {
    titleJa: '資生堂 エリクシール ルフレ バランシング おしろいミルク',
    title: '资生堂 ELIXIR 平衡乳液',
    category: 'beauty',
    weightG: 180,
    priceJpy: 3300,
    janCode: '4901872088412',
    hsCode: '3304.99',
    customsDescEn: 'Skin care emulsion, 100g',
    purchaseSource: '松本清',
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
    purchaseSource: '合羽橋 道具街',
  },
  {
    titleJa: 'サーモス 真空断熱ケータイマグ 500mL',
    title: '膳魔师 保温杯 500mL',
    category: 'lifestyle',
    weightG: 300,
    priceJpy: 4500,
    janCode: '4971878012345',
    hsCode: '9617.00',
    customsDescEn: 'Vacuum insulated tumbler, 500mL',
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
    purchaseSource: '岩手 直送',
  },
  {
    titleJa: '獺祭 純米大吟醸 45 四割五分 720mL',
    title: '獭祭 纯米大吟酿 四割五分 720mL',
    category: 'food',
    weightG: 1200,
    priceJpy: 3850,
    janCode: '4973157001234',
    hsCode: '2206.00',
    customsDescEn: 'Rice wine (sake), 720mL, 15% ABV',
    purchaseSource: '山口 酒造',
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
    purchaseSource: '新潟 JA',
  },
  {
    titleJa: '無印良品 ゲルインクボールペン 0.5mm 5本組',
    title: '无印良品 中性笔 0.5mm 5 支装',
    category: 'lifestyle',
    weightG: 60,
    priceJpy: 550,
    janCode: '4547315001234',
    hsCode: '9608.10',
    customsDescEn: 'Ball point pens, 5 pieces',
    purchaseSource: '無印良品',
  },
];

/**
 * 运费阶梯（**占位**，见 @limitation 二）。
 * @why `max_weight_g` 是"上限（含）"，取档方向必须是**第一个 ≥ 包裹重**的档（向上取档）。
 *      这里给出红线向量：包裹重 1850g → 应取 2000g 档 → 4,950 円。
 *      历史上这里长期用错方向（VLOOKUP 向下取档），导致每单少收 900–1,000 円且静默无报错。
 */
export interface ShippingTier {
  maxWeightG: number;
  priceJpy: number;
}

export const SHIPPING_TIER_ANCHOR = { maxWeightG: 2000, priceJpy: 4950 } as const;

export const SHIPPING_TIERS: readonly ShippingTier[] = [
  { maxWeightG: 500, priceJpy: 1980 },
  { maxWeightG: 1000, priceJpy: 2750 },
  { maxWeightG: 1500, priceJpy: 4050 },
  SHIPPING_TIER_ANCHOR,
  { maxWeightG: 2500, priceJpy: 5800 },
  { maxWeightG: 3000, priceJpy: 6600 },
  { maxWeightG: 4000, priceJpy: 8100 },
  { maxWeightG: 5000, priceJpy: 9600 },
  { maxWeightG: 6000, priceJpy: 11000 },
  { maxWeightG: 10000, priceJpy: 15000 },
];

/** 运费取档：第一个 `max_weight_g >= 重量` 的档（向上取档）。超重返回 null。 */
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

export const US_ADDRESSES: readonly AddressSeed[] = [
  { recipient: 'Zhang Wei', line1: '350 5th Ave Apt 12B', line2: null, city: 'New York', state: 'NY', postalCode: '10118', areaCode: '212' },
  { recipient: 'Li Na', line1: '1234 Wilshire Blvd Unit 305', line2: 'Floor 3', city: 'Los Angeles', state: 'CA', postalCode: '90017', areaCode: '213' },
  { recipient: 'Chen Hao', line1: '233 S Wacker Dr Ste 800', line2: null, city: 'Chicago', state: 'IL', postalCode: '60606', areaCode: '312' },
  { recipient: 'Wang Fang', line1: '1201 Louisiana St', line2: 'Apt 2204', city: 'Houston', state: 'TX', postalCode: '77002', areaCode: '713' },
  { recipient: 'Liu Yang', line1: '600 4th Ave', line2: null, city: 'Seattle', state: 'WA', postalCode: '98104', areaCode: '206' },
  { recipient: 'Zhao Min', line1: '200 NE 1st St', line2: 'Unit 15', city: 'Miami', state: 'FL', postalCode: '33132', areaCode: '305' },
  { recipient: 'Sun Qi', line1: '1 Beacon St', line2: null, city: 'Boston', state: 'MA', postalCode: '02108', areaCode: '617' },
  { recipient: 'Zhou Lei', line1: '1601 Larimer St', line2: 'Apt 907', city: 'Denver', state: 'CO', postalCode: '80202', areaCode: '303' },
  // 刻意包含 ZIP+4 形态：覆盖 postal_code CHECK 的可选后缀分支
  { recipient: 'Wu Jing', line1: '88 Kearny St', line2: null, city: 'San Francisco', state: 'CA', postalCode: '94108-4567', areaCode: '415' },
];

/** 生成一个满足 `^\+1[0-9]{10}$` 的电话。区号取自素材，后 7 位来自传入的随机源。 */
export function formatUsPhone(areaCode: string, sevenDigits: number): string {
  const tail = String(sevenDigits).padStart(7, '0').slice(-7);
  return `+1${areaCode}${tail}`;
}
