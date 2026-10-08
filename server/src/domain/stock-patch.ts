/**
 * 职责：`PATCH /admin/products/{id}/stock`（列表内联改库存，AJ-403）请求体的校验——纯函数，无外部依赖。
 *
 * @why 单独一个文件而不是复用 `product-input.ts`：那份校验的是**整行商品**（十几个字段 + 上架规则），
 *      这里只有两个整数；混进去会让"改库存"被标题、报关品名之类与它无关的规则拦下。
 * @why `expected_stock` **必填**（与 PUT 带 stock 时同口径，P2-8 / AJ-386）：
 *      没有凭据的绝对值覆盖会抹掉期间的下单扣减，多卖出不存在的货。
 * @why 上界 = Postgres `INT` 上界（`products.stock INT`）：越界值若放进 SQL，库抛 22003，
 *      由 http.ts 的兜底（22 类 → 40001，reason `sql_data_exception:22003`）接住——不会 500，
 *      但 reason 指向"库拒收"而不是"库存填错"，且白跑一次库往返。在这里拦成 `stock_invalid` 是为了**原因说得准**。
 *      ⚠️ 首稿这里写的是"路由只能回 50000"——缺陷注入（去掉上界）时路由用例仍绿，查下去才发现兜底早已存在（H5）。
 *      @measured PostgreSQL 16.15（postgres.js）：`select 2147483647::int` → 2147483647；
 *                `select 2147483648::int` → 抛错，`e.code = '22003'`，message `integer out of range`。
 * @limitation 上界是**技术**上界，不是业务上界：手滑把 30 打成 300000 仍会被接受。
 *             整行 PUT（product-input.ts `intAtLeast`）连这条技术上界都没有——登记在 AJ-403 反向风险里，本单元不改它。
 * @tradeoff 只认 JSON number，不认 `"30"` 这种字符串数字：前端从输入框取值后自己转数，
 *           服务端替它猜"字符串是不是数"会让"传错类型"与"传对了"不可区分（与 AJ-352 同口径）。
 */

import { PRODUCT_MAX_STOCK } from '@waselect/shared';

/** Postgres INT（int4）的最大值（真源在 shared，前后端同一个数）。 */
export const PG_INT_MAX = PRODUCT_MAX_STOCK;

export type StockPatchResult =
  | { ok: true; stock: number; expectedStock: number }
  | { ok: false; reason: 'stock_invalid' | 'expected_stock_required' };

function nonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= PG_INT_MAX;
}

export function parseStockPatch(body: unknown): StockPatchResult {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (!nonNegInt(b['stock'])) return { ok: false, reason: 'stock_invalid' };
  if (!nonNegInt(b['expected_stock'])) return { ok: false, reason: 'expected_stock_required' };
  return { ok: true, stock: b['stock'], expectedStock: b['expected_stock'] };
}
