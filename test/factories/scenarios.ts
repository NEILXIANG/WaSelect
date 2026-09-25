/**
 * 职责：场景集（F9-d）——把单个工厂组合成**有业务语义的一组实体**（而不是再来一个工厂）。
 *
 * @why 单个工厂只造"一个东西"，而测试与本地联调要的是"一家店"：用户、地址、商品、运费档之间
 *      有真实引用关系（`address.user_id → user.id`）。把这些组合散写在每个用例里，
 *      会出现"同一个 demo 在三个文件里各有一份、细节还不一样"的漂移。
 *
 * @why 跨档边界单独成组而不是混在随机测试里：运费取档是「第一个 `max_weight_g >= 重量` 的档」
 *      （向上取档，D-46 曾因为用成向下取档每单少收 900–1000 円、占净贡献 24–26%，且静默不报错）。
 *      边界两侧恰恰是"向下取档"这种错法唯一会改坏的地方——档内随机值两边看起来都一样。
 *      向量**派生自 `SHIPPING_TIERS`**（每档取上限与上限+1），所以改档不用改用例；
 *      同时**显式钉住红线向量**（`TIER_REDLINE_CASES`）——派生逻辑写坏时，显式钉住的那几条照样红。
 *
 * @limitation 一：场景**不造订单实体**。订单的金额勾稽（total = items + shipping + duty）与状态机
 *              属业务期（见 entities.ts @tradeoff）；现在强造会逼着工厂去猜还没定的规则，
 *              而猜错的规则会以"看起来是地基"的身份留下来。
 * @limitation 二：`demoShop` 的商品取 `JP_PRODUCTS` 前 4 个（确定性），不追求覆盖全部品类。
 *              它是给"本地联调要点开商品列表看一眼"用的，不是覆盖率工具——
 *              覆盖率由 `fullCatalog` 与 catalog 的审计（manifest/）负责。
 * @limitation 三：`fullCatalog` 用 `makeProduct` + 逐字段覆盖来锁定 identity，而不是改 `makeProduct`
 *              去支持"指定 seed"——`makeProduct` 的职责是"随机造一个"（随机性是它的性质），
 *              给它加"确定性模式"会让同一个函数有两种语义。
 *
 * @see catalog.ts（素材 JP_PRODUCTS / SHIPPING_TIERS / US_ADDRESSES）；entities.ts（行工厂）；
 *      scenarios.db.test.ts（场景必须整体入库 + 边界向量必须命中预期档）
 */
import {
  makeAddress,
  makeProduct,
  makeShippingRates,
  makeUser,
  type AddressRow,
  type ProductRow,
  type ShippingRateRow,
  type UserRow,
} from './entities.js';
import {
  JP_PRODUCTS,
  pickTier,
  SHIPPING_TIERS,
  type ProductSeed,
  type ShippingTier,
} from './catalog.js';
import type { Rng } from './rng.js';

/** 一组能整体灌进库的实体。name/description 供一键灌数据脚本打印确认。 */
export interface SeedBundle {
  readonly name: string;
  readonly description: string;
  users: UserRow[];
  addresses: AddressRow[];
  products: ProductRow[];
  shippingRates: ShippingRateRow[];
}

/**
 * 用 `makeProduct` 造一个商品，但**逐字段覆盖**成指定 seed（确定性）。
 * @why 不走 `makeProduct` 的随机 pick：场景集的价值是"这一批数据每次长得一模一样"，
 *      随机 pick 会让同一份 seed 灌出不同的店。
 */
function productFromSeed(seed: ProductSeed, rng: Rng, nextId: () => string): ProductRow {
  return makeProduct(rng, nextId, {
    title: seed.title,
    title_ja: seed.titleJa,
    category: seed.category,
    description: `${seed.titleJa}（${seed.purchaseSource}）`,
    price_jpy: seed.priceJpy,
    cost_jpy: Math.round((seed.priceJpy * 60) / 100),
    weight_g: seed.weightG,
    hs_code: seed.hsCode,
    customs_desc_en: seed.customsDescEn,
    jan_code: seed.janCode,
    purchase_source: seed.purchaseSource,
  });
}

/** 完整商品目录 + 完整运费档 + 一个用户与默认地址。供全量联调与"灌满看一看"。 */
export function fullCatalog(rng: Rng, nextId: () => string): SeedBundle {
  const user = makeUser(rng, nextId);
  return {
    name: 'full-catalog',
    description: `${JP_PRODUCTS.length} 商品（全部目录）+ ${SHIPPING_TIERS.length} 运费档 + 1 用户 + 1 默认地址`,
    users: [user],
    addresses: [makeAddress(rng, nextId, user.id, { is_default: true })],
    products: JP_PRODUCTS.map((s) => productFromSeed(s, rng, nextId)),
    shippingRates: makeShippingRates(),
  };
}

/** 精简 demo 店：4 商品 + 1 用户 + 1 默认地址 + 完整运费档。前端联调点开"像一家店"即可。 */
export function demoShop(rng: Rng, nextId: () => string): SeedBundle {
  const user = makeUser(rng, nextId);
  const products = JP_PRODUCTS.slice(0, 4).map((s) => productFromSeed(s, rng, nextId));
  return {
    name: 'demo-shop',
    description: '4 商品（目录前四个，确定性）+ 1 用户 + 1 默认地址 + 完整运费档',
    users: [user],
    addresses: [makeAddress(rng, nextId, user.id, { is_default: true })],
    products,
    shippingRates: makeShippingRates(),
  };
}

/** 一条跨档边界用例。 */
export interface TierBoundaryCase {
  weightG: number;
  /** 期望命中的档（引用 `SHIPPING_TIERS` 的元素，对象相等即通过）；null = 超重不命中任何档。 */
  expect: ShippingTier | null;
  why: string;
}

/**
 * 派生的边界向量：对每一档造"恰好到上限（命中本档）"与"上限+1（进下一档）"两条。
 * @returns 数量 = 2 × 档数。最后一档的"上限+1"期望 null（超重）。
 * @why 派生而不是手写：手写向量在改档时必然忘了同步（而 `pickTier` 的错误恰恰是静默的）。
 */
export function tierBoundaryCases(): TierBoundaryCase[] {
  const cases: TierBoundaryCase[] = [];
  for (let i = 0; i < SHIPPING_TIERS.length; i += 1) {
    const t = SHIPPING_TIERS[i];
    if (t === undefined) continue;
    cases.push({
      weightG: t.maxWeightG,
      expect: t,
      why: `w=${t.maxWeightG} 恰好到档上限，应命中本档 ${t.maxWeightG}g`,
    });
    const next = SHIPPING_TIERS[i + 1];
    cases.push({
      weightG: t.maxWeightG + 1,
      expect: next ?? null,
      why:
        next === undefined
          ? `w=${t.maxWeightG + 1} 超最重档，应返回 null（转人工，不能静默进最贵档）`
          : `w=${t.maxWeightG + 1} 越过本档，应进下一档 ${next.maxWeightG}g`,
    });
  }
  return cases;
}

/**
 * 显式钉住的红线向量（不依赖派生逻辑）。
 * @why D-46 的事故形态是"向上取档被写成向下取档"：w=1850 时返回 1500 档（4050 円）
 *      而不是 2000 档（4950 円）。这条向量**必须独立于 `tierBoundaryCases()` 的派生循环**存在——
 *      派生循环和 `pickTier` 若被同一个错法同时改坏，派生用例会跟着错、照样绿；
 *      只有"独立于推导链的已知答案"能抓出来（与 §2 第 25 条"独立参考向量"同源）。
 */
export const TIER_REDLINE_CASES: readonly TierBoundaryCase[] = [
  {
    weightG: 1850,
    expect: pickTier(2000),
    why: 'D-46 红线：1850 必须进 2kg 档（4950 円），不是 1500 档（4050 円）',
  },
  {
    weightG: 10001,
    expect: null,
    why: '超最重档返回 null（转人工 / 拒单），不能静默进最贵档（14000 円）',
  },
];
