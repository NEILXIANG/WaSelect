/**
 * 职责：`PUT /admin/shipping-rates` 的**整表**校验（I2 U-C1）。
 *
 * @why 校验粒度必须是**整表**而不是"逐条"：契约明文这是**整表替换**，
 *      单条全部合法、整表仍然可能是错的（空表 / 重复档 / 两家承运商同时启用），
 *      而这三类的表现全都一样——"保存成功，然后某些重量取不到档或全站报不了价"。
 *      逐条校验会把它们全部放过，而且不报错（与 D-46 取档方向同源的静默）。
 *
 * @why 🔴 "启用的承运商必须恰好一家"是本函数**最要紧**的一条：
 *      `adapters/catalog.ts` 的 `resolveSingleActiveCarrier()` 在活跃承运商 ≠1 家时返回 null，
 *      调用方随即抛 **50004 运费不可计算**——即**全站报价与建单全部失败**。
 *      `shipping_rates` 这张表唯一能改变该不变量的操作就是本接口（整表替换），
 *      所以守卫必须在**这里**，不能指望 DB 约束（UNIQUE(carrier, max_weight_g) 只挡重复档，
 *      不挡"两家承运商"）。
 *
 * @limitation 一：⚠️ **只有"极端"量纲护栏（`SHIPPING_RATE_BOUNDS`，AJ-297），挡不住 10 倍**——
 *              ✅ 已能挡：多打**两个** 0（`max_weight_g` 2000 → 200000、`price_jpy` 2000 → 200000）。
 *              ❌ 挡不住：多打**一个** 0（2000 → 20000）——20kg / 2万円的档位**本身合法**，
 *              而运费档位的合法区间天然跨一个数量级（¥2000 的轻小件档与 ¥40,000 的 20kg 档都对），
 *              任何绝对阈值要么漏拦 10 倍、要么误拦真实档位，二者只能选一个。
 *              ⇒ 10 倍的精确检测只能靠"与上一版逐档比较"，而整表替换下这个比较在**正常重构**
 *              （增删档、调边界）时假阳性很高；更关键的是它必须配"确认出口"，
 *              否则"改正上次录错的值"这个动作自己会被拦住（这是 fx 侧同样的问题，
 *              那里改用绝对区间绕开了它，这里绕不开）。完整取舍见 AJ-297。
 *              ✅ 可观测已足够：路由层 `admin_shipping_rates_replaced` 把替换前后**整表逐档**
 *              写进日志，"之前是多少"随时可答，对账能直接定位到哪一档变了。
 *              剩余风险由页面二次确认 + 对账承担（不再是"完全没有防护"）。
 * @limitation 二：不校验"档位是否连续覆盖"（比如只有 500g 一档，1kg 的包裹取不到档）。
 *              覆盖率是运营决策（有些重量本来就不卖），且超重已有 50004 兜底——
 *              拦在保存时会让"刻意只留一档"的合法配置也存不进去。
 *
 * @see contracts/api-contract.yaml（ShippingRate / PUT /admin/shipping-rates）；
 *      adapters/catalog.ts（D-46 唯一取档 SQL + resolveSingleActiveCarrier）；
 *      admin-web/src/ops/view.ts（前端同一套整表校验：rateErrors）
 */
import { SHIPPING_RATE_BOUNDS } from '@waselect/shared';
import { AppError } from '../errors.js';
import { optionalBool } from './bool-input.js';

/** 列宽（与 001 的 VARCHAR(32) 一致）：超长属"形状错"（40001），DB 兜底是最后一道。 */
const MAX_CARRIER_LEN = 32;

/** 校验后的一档运费（提交给仓储的形状）。 */
export interface ShippingRateInput {
  carrier: string;
  maxWeightG: number;
  priceJpy: number;
  active: boolean;
}

/**
 * 校验并取出整张运费表（纯：不查库、不取时钟）。
 * @throws {AppError} 40001 形状 / 数值域 / 整表约束（见文件头 @why）
 */
export function parseShippingRates(body: unknown): ShippingRateInput[] {
  if (!Array.isArray(body)) throw new AppError(40001, { reason: 'body_shape' });
  if (body.length === 0) throw new AppError(40001, { reason: 'rates_empty' });

  const out: ShippingRateInput[] = [];
  const seen = new Set<string>();
  const activeCarriers = new Set<string>();

  body.forEach((raw, i) => {
    const r = raw as Record<string, unknown> | null;
    if (r === null || typeof r !== 'object') {
      throw new AppError(40001, { reason: 'row_shape', index: i });
    }
    const carrier = typeof r['carrier'] === 'string' ? r['carrier'].trim() : '';
    if (carrier === '' || carrier.length > MAX_CARRIER_LEN) {
      throw new AppError(40001, { reason: 'carrier_invalid', index: i });
    }
    const maxWeightG = r['max_weight_g'];
    const priceJpy = r['price_jpy'];
    if (!Number.isInteger(maxWeightG) || (maxWeightG as number) < 1) {
      throw new AppError(40001, { reason: 'max_weight_g_invalid', index: i });
    }
    // 0 円运费合法（手动包邮）；负数不是
    if (!Number.isInteger(priceJpy) || (priceJpy as number) < 0) {
      throw new AppError(40001, { reason: 'price_jpy_invalid', index: i });
    }
    // AJ-297：绝对量纲上界。拦"多打两个 0"这类极端录入；10 倍拦不住，理由见 @limitation 一。
    // @why 用独立的 reason 而不是复用 `_invalid`：形状错（不是整数）与量纲错（是整数但大得
    //      不成立）在运营眼里是两件事——前者是"填错了格式"，后者是"数字打多了"。
    if ((maxWeightG as number) > SHIPPING_RATE_BOUNDS.maxWeightG) {
      throw new AppError(40001, {
        reason: 'max_weight_g_out_of_range',
        index: i,
        max: SHIPPING_RATE_BOUNDS.maxWeightG,
      });
    }
    if ((priceJpy as number) > SHIPPING_RATE_BOUNDS.priceJpy) {
      throw new AppError(40001, {
        reason: 'price_jpy_out_of_range',
        index: i,
        max: SHIPPING_RATE_BOUNDS.priceJpy,
      });
    }
    const key = `${carrier}|${String(maxWeightG)}`;
    if (seen.has(key)) throw new AppError(40001, { reason: 'tier_duplicated', index: i });
    seen.add(key);

    // ⚠️ AJ-353：旧写法 `r['active'] !== false` 把 `"false"` / `0` / `"no"` 一律当成**启用**。
    //    运营想停用一个档位而传了字符串 "false"（CSV 导入最常见的列型事故），
    //    结果是这个档**照常参与取档** ⇒ 运费可能算成另一个数，且没有任何一方报错。
    //    与 product-input 的 `strField`（AJ-352）是同一条：填了但类型不对，必须响。
    const active = optionalBool(r['active'], 'active', true, (reason) => {
      throw new AppError(40001, { reason, index: i });
    });
    if (active) activeCarriers.add(carrier);
    out.push({ carrier, maxWeightG: maxWeightG as number, priceJpy: priceJpy as number, active });
  });

  if (activeCarriers.size === 0) throw new AppError(40001, { reason: 'no_active_tier' });
  // 🔴 D-46 同源守卫：≠1 家活跃承运商 = 全站 50004（文件头 @why）
  if (activeCarriers.size !== 1) {
    throw new AppError(40001, { reason: 'carrier_not_single', carriers: [...activeCarriers] });
  }
  return out;
}
