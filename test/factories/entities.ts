/**
 * 职责：实体工厂（F9-c）——产出**能直接 INSERT 进真表**的一行数据。
 *
 * @why 校验工厂产物有两种做法，这里选更强的那种：
 *      - 弱：自己写一份 zod schema 校验自己造的数据（循环论证，schema 写错就一起错）
 *      - 强：**插进真库**，让 DDL 的 CHECK / NOT NULL / FK / 唯一约束当裁判
 *      后者能抓到"我以为这个字段能为空"这类只在真实约束下才现形的问题。
 *
 * @tradeoff 工厂不做业务不变量（比如 total = items + shipping + duty）：
 *      那是**业务规则**，属于订单服务的职责，放在工厂里会让"规则改了但工厂没改"变成假绿灯。
 *      工厂只保证"结构合法 + 数值自洽到能入库"，金额关系由订单组装函数负责（业务期）。
 *
 * @limitation 一：ID 用 `createIdFactory`（确定性、非加密随机）。
 *              形状像 ULID 但**不含时间序**，所以同一批数据的 created_at 与 ID 顺序无关。
 * @limitation 二：`status` 默认一律取 shared 枚举的第一个合法值，不模拟状态迁移。
 *              状态机的迁移规则属 F10，工厂造"已支付订单"这类需求要等业务期明确规则后再加。
 * @limitation 三：邮箱统一用 `example.com`（RFC 2606 保留域），
 *              避免灌数据时给真实域名发信——测试环境串到生产 SMTP 是真实事故。
 *
 * @see migrations/001_init.sql（约束来源）；catalog.ts（素材）；rng.ts（随机源）
 */
import { createIdFactory } from '../../packages/shared/src/id.js';
import {
  JP_PRODUCTS,
  SHIPPING_TIERS,
  US_ADDRESSES,
  formatUsPhone,
  type AddressSeed,
  type ProductSeed,
} from './catalog.js';
import type { Rng } from './rng.js';

export interface UserRow {
  id: string;
  openid: string;
  email: string | null;
  phone: string | null;
  is_admin: boolean;
}

export interface AddressRow {
  id: string;
  user_id: string;
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

export interface ProductRow {
  id: string;
  title: string;
  title_ja: string;
  category: string;
  description: string | null;
  images: string[];
  price_jpy: number;
  cost_jpy: number | null;
  weight_g: number;
  stock: number;
  compliance_tags: string[];
  hs_code: string | null;
  customs_desc_en: string | null;
  origin_country: string;
  jan_code: string | null;
  purchase_source: string | null;
  status: string;
}

export interface ShippingRateRow {
  carrier: string;
  max_weight_g: number;
  price_jpy: number;
  active: boolean;
}

/** 工厂共用的 ID 源；同一 seed 下所有工厂的 ID 序列都固定。 */
export function createIds(seed: number | string): () => string {
  const numeric = typeof seed === 'string' ? Math.abs(hash(seed)) + 1 : seed;
  return createIdFactory(numeric);
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * 造一个买家。
 * @param overrides 覆盖任意字段（用例要造"被封禁用户"等特例时用）
 */
export function makeUser(rng: Rng, nextId: () => string, overrides: Partial<UserRow> = {}): UserRow {
  const seq = rng.int(1, 999999);
  const base: UserRow = {
    id: nextId(),
    openid: `o-fixture-${seq}`,
    email: `user${seq}@example.com`,
    phone: null,
    is_admin: false,
  };
  return { ...base, ...overrides };
}

/** 造一个美国收件地址（素材来自 catalog，电话按区号拼出合法 E.164）。 */
export function makeAddress(
  rng: Rng,
  nextId: () => string,
  userId: string,
  overrides: Partial<AddressRow> = {},
): AddressRow {
  const seed: AddressSeed = rng.pick(US_ADDRESSES);
  const base: AddressRow = {
    id: nextId(),
    user_id: userId,
    recipient: seed.recipient,
    phone: formatUsPhone(seed.areaCode, rng.int(0, 9_999_999)),
    line1: seed.line1,
    line2: seed.line2,
    city: seed.city,
    state: seed.state,
    postal_code: seed.postalCode,
    country: 'US',
    is_default: false,
  };
  return { ...base, ...overrides };
}

/**
 * 造一个商品。
 * @why `origin_country` 硬编码 'JP'：DB 有 `CONSTRAINT products_origin_jp CHECK (origin_country = 'JP')`
 *      （D-43：MVP 只卖日产）。这里不提供覆盖入口——让它成为"想改都改不了"的约束。
 */
export function makeProduct(
  rng: Rng,
  nextId: () => string,
  overrides: Partial<ProductRow> = {},
): ProductRow {
  const seed: ProductSeed = rng.pick(JP_PRODUCTS);
  const base: ProductRow = {
    id: nextId(),
    title: seed.title,
    title_ja: seed.titleJa,
    category: seed.category,
    description: `${seed.titleJa}（${seed.purchaseSource}）`,
    images: [],
    price_jpy: seed.priceJpy,
    // 成本按零售价 55–70% 取（免税店进货的粗略量级，占位）
    cost_jpy: Math.round((seed.priceJpy * rng.int(55, 70)) / 100),
    weight_g: seed.weightG,
    stock: rng.int(0, 200),
    compliance_tags: [],
    hs_code: seed.hsCode,
    customs_desc_en: seed.customsDescEn,
    origin_country: 'JP',
    jan_code: seed.janCode,
    purchase_source: seed.purchaseSource,
    status: 'active',
  };
  return { ...base, ...overrides };
}

/** 造一整张运费表（素材来自 catalog 的占位阶梯）。 */
export function makeShippingRates(carrier = 'placeholder'): ShippingRateRow[] {
  return SHIPPING_TIERS.map((t) => ({
    carrier,
    max_weight_g: t.maxWeightG,
    price_jpy: t.priceJpy,
    active: true,
  }));
}
