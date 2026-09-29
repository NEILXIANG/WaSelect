/**
 * 职责：**建单核心**（I1-U5b）——在给定事务里完成一次真实建单：
 *      校验 → 重算 → 扣库存 → 写 orders/order_items/order_events。
 *
 * @why 从路由薄壳里抽出来（路由只做 HTTP 形状与幂等包装）：
 *      D32 的"单号撞唯一约束 → savepoint 重试"必须用**可控的 IdGen 序列**才能测到
 *      （第一次撞、第二次成），而 mountAllRoutes 用 systemIdGen——
 *      核心函数可注入，路由与 D32 测试共用同一份逻辑，不存在"测试的是另一份"。
 *
 * @why 全部读取都在**本事务内**（无 TOCTOU）：管理端改价/改汇率与建单并发时，
 *      本事务读到的快照就是落库的快照——"报价页看到的价"与"实际建单价"可能不同，
 *      那由 40905（expected_total_jpy）负责表达，而不是靠两阶段读取碰运气。
 *
 * @why D32 用 **savepoint** 重试而不是 catch 后继续：PG 事务内一条语句报错，
 *      整个事务进入 aborted 状态，不回滚到 savepoint 则后续语句全部 25P02。
 *      重试上限 3 次（含首次）后仍撞 → 50000 + error 日志：
 *      6 位 Crockford 段在同业务日内撞 3 次，不是"运气差"而是随机源/规则坏了，
 *      响亮失败让运维来看，不要静默循环。
 *
 * @limitation 一：扣库存用条件更新（decrementStock），逐行执行、任一失败整单回滚——
 *              没有"部分成交"。@tradeoff 代价是热销品并发建单时后到的请求整单 40901，
 *              而不是"能买几件买几件"（那是购物车语义，不是建单语义）。
 * @limitation 二：declared_value_usd 的基数是**商品小计**（与 duty 同口径 = 按成交价申报，13b 已由 AJ-142 定案；
 *              一致性审计 C9 更正原「13b 未定」。运费不计入申报价——实付含运费，二者本就不等）；
 *              分摊用 allocate（最大余额法），保证各行之和 === toMinor(小计)，不差 1 分。
 * @limitation 三：terms_version 的比对源是 config.TERMS_VERSION（D-I1-3：app_config 不接线）。
 *
 * @see app/order-routes.ts（路由薄壳：HTTP 形状 + 幂等）；app/quote-assembly.ts（重算）；
 *      adapters/orders.ts（SQL）；docs/I1阶段开发实施方案.md §3.5；技术文档 §1（D-29/D-32）
 */
import type { Db } from '../adapters/db.js';
import { withSavepoint } from '../adapters/db.js';
import { plusMs } from '../adapters/clock.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/ids.js';
import type { AppConfig } from '../config.js';
import {
  decrementStock,
  findOwnedAddress,
  insertOrder,
  insertOrderItems,
  type OrderItemInsertRow,
} from '../adapters/orders.js';
import { createCatalogRepo } from '../adapters/catalog.js';
import {
  summarizeQuoteItems,
  type QuoteComputation,
  type QuoteItemInput,
  type QuoteProduct,
} from '../domain/quote.js';
import { buildOrderNo } from '../domain/order-no.js';
import { assembleQuote } from './quote-assembly.js';
import { allocate, toMinor, toRateInt } from '@waselect/shared';

/** D32：单号撞唯一约束的最大尝试次数（含首次）。 */
export const ORDER_NO_MAX_ATTEMPTS = 3;

/**
 * 商品 id 的**确定序**比较——只服务于第 6 步的取锁顺序。
 *
 * @why 不能用 `localeCompare`：它走 ICU collation，结果随 Node 构建（small-icu / full-icu）
 *      与 ICU 版本而变。两个实例对同一组 id 若算出**不同**的锁序，"统一取锁顺序"
 *      就只在单实例内成立，跨实例仍然是 AB / BA 互等（40P01）——
 *      而防死锁恰恰只在**多实例并发**时才有意义，单机测出来绿说明不了任何事。
 * @limitation 结果不符合任何自然语言的字典序（大写整体排在小写之前）；
 *              锁序不需要好看，只需要"每个进程算出同一个结果"。
 *              id 出现非 ASCII 时 codePoint 序依然确定——与 locale 无关正是选它的理由。
 */
export function compareProductIdForLock(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface CreateOrderInput {
  userId: string;
  items: readonly QuoteItemInput[];
  addressId: string;
  termsVersion: string | undefined;
  expectedTotalJpy?: number | undefined;
  contactEmail?: string | undefined;
}

export interface CreateOrderDeps {
  config: AppConfig;
  clock: Clock;
  idGen: IdGen;
  logger: Logger;
}

export interface CreatedOrder {
  orderId: string;
  orderNo: string;
  expiresAt: Date;
  q: QuoteComputation;
  /** 建单时刻的汇率快照（display 币种 → NUMERIC 小数，OrderCreated.fx_snapshot 同形）。 */
  fxSnapshot: Record<string, number>;
}

/** 23505（unique_violation）判定——postgres.js 错误结构，不 import 驱动（与 payment-intent.ts 同模式）。 */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === '23505';
}

/**
 * 建单（**必须在调用方的事务里调用**；本函数不再开事务，只用 savepoint 做 D32 重试）。
 *
 * @throws {AppError} 40011 条款版本缺失/不匹配 | 40400 地址不存在或非本人 |
 *         40401 商品不存在/已下架 | 40901 库存不足 | 40905 价格已变动 |
 *         40906 超单笔上限 | 50003 汇率缺失 | 50004 运费不可计算 | 50000 单号三连撞
 */
export async function createOrder(
  tx: Db,
  deps: CreateOrderDeps,
  input: CreateOrderInput,
): Promise<CreatedOrder> {
  const { config, clock, idGen, logger } = deps;

  // ── 1. 条款版本（D-43/D-I1-3）：缺失与不匹配一律拒单 ─────────────────────
  if (input.termsVersion === undefined || input.termsVersion !== config.TERMS_VERSION) {
    throw new AppError(40011, { reason: 'terms_version_mismatch' });
  }
  // 捕获为局部常量：属性收窄进不了 withSavepoint 的闭包（TS 对可变成员的窄化不跨闭包）
  const termsVersion = input.termsVersion;

  // ── 2. 收货地址（归属判定：非本人与不存在同码 40400，防存在性探测）─────────
  const address = await findOwnedAddress(tx, input.addressId, input.userId);
  if (address === null) throw new AppError(40400, { address_id: input.addressId });

  // ── 2b. 审核模式（技术文档 §2.9 / AJ-179）：只有 REVIEW_SKU_ID 能下单 ──────────
  // @why 审核期全店只能走 mock（config 规则 2b），任何能下单的商品都能被"假付款"确认——
  //      闸门必须在建单处（扣库存之前），不能只在支付处：否则审核员能把真商品库存占满 30 分钟。
  //      用 40401（商品不存在或已下架）：对买家而言它就是"此刻买不了"，不另开一个只在审核期出现的码。
  const reviewMode = config.REVIEW_MODE === 'on';
  if (reviewMode) {
    const outside = input.items
      .map((i) => i.productId)
      .filter((pid) => pid !== config.REVIEW_SKU_ID);
    if (outside.length > 0) {
      logger.warn('order_review_sku_rejected', {
        result: 'rejected',
        ctx: { product_ids: outside.slice(0, 10) },
      });
      throw new AppError(40401, { product_id: outside[0], reason: 'review_mode_sku_only' });
    }
  }

  // ── 3. 商品快照与行项目汇总（40001/40401/40901 初筛）─────────────────────
  const catalog = createCatalogRepo(tx);
  const rows = await catalog.findProductsForQuote(input.items.map((i) => i.productId));
  const products: QuoteProduct[] = rows.map((r) => ({
    productId: r.id,
    priceJpy: r.price_jpy,
    weightG: r.weight_g,
    stock: r.stock,
    active: r.status === 'active',
    originCountry: r.origin_country,
  }));
  const summary = summarizeQuoteItems(input.items, products);

  // ── 4. 服务端重算（与报价同一份装配；申报价值必须 USD，并入同一次 fx 查询）──
  const { q, fxMap, carrier, dest } = await assembleQuote(tx, config, clock, summary, ['USD']);

  // ── 5. 客户端确认价对账（40905）与单笔上限（40906，D-42）──────────────────
  if (input.expectedTotalJpy !== undefined && input.expectedTotalJpy !== q.totalJpy) {
    throw new AppError(40905, {
      expected: input.expectedTotalJpy,
      actual: q.totalJpy,
    });
  }
  if (q.totalJpy > config.MAX_ORDER_JPY) {
    throw new AppError(40906, { total_jpy: q.totalJpy, max: config.MAX_ORDER_JPY });
  }

  // ── 6. 原子扣库存（任一失败整单回滚，@limitation 一）──────────────────────
  // ⚠️ 按 product_id **排序后**逐行扣（全量审计 2026-09-26 P1）：两张单以相反顺序含同两件商品时，
  //    行锁获取顺序 AB / BA 交叉 → PG 40P01 死锁 → 非 AppError → 50000。
  //    @measured 探针：同 SQL 交叉更新复现 `deadlock detected`；真 createOrder 并发 20 轮出现 17 次。
  //    统一顺序后所有事务对同一组行按同一序取锁，只会排队不会互等。
  const orderedItems = [...input.items].sort((a, b) =>
    compareProductIdForLock(a.productId, b.productId),
  );
  for (const item of orderedItems) {
    const ok = await decrementStock(tx, item.productId, item.qty);
    if (!ok) throw new AppError(40901, { product_id: item.productId, qty: item.qty });
  }

  // ── 7. 写 orders（D32：order_no 撞 23505 → savepoint 重取，最多 3 次）────────
  const orderId = `ord-${idGen.uuid()}`;
  const expiresAt = plusMs(clock.now(), config.ORDER_PAYMENT_TTL_MIN * 60_000);
  const fxSnapshot: Record<string, number> = {};
  for (const [quote, rate] of fxMap) fxSnapshot[quote] = Number(rate);

  let orderNo: string | undefined;
  for (let attempt = 1; attempt <= ORDER_NO_MAX_ATTEMPTS; attempt += 1) {
    const candidate = buildOrderNo(clock, idGen.orderSeq());
    try {
      await withSavepoint(tx, (sp) =>
        insertOrder(sp, {
          id: orderId,
          order_no: candidate,
          user_id: input.userId,
          items_jpy: q.itemsJpy,
          shipping_jpy: q.shippingJpy,
          // duty 是信息字段不入应收；落库列 NOT NULL，无估算时存 0（口径：该列仅对账参考）
          duty_jpy: q.dutyJpy ?? 0,
          total_jpy: q.totalJpy,
          weight_g: q.weightG,
          // JSONB 列传对象（tx.json 单重编码；`${字符串}::jsonb` 是双重编码，见 orders.ts ⚠️）
          fx_snapshot: fxSnapshot,
          address_snapshot: address,
          contact_email: input.contactEmail ?? null,
          terms_version: termsVersion,
          expires_at: expiresAt,
          is_test: reviewMode,
        }),
      );
      orderNo = candidate;
      break;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (attempt === ORDER_NO_MAX_ATTEMPTS) {
        logger.error('order_no_collision_exhausted', {
          result: 'failed',
          ctx: { attempts: ORDER_NO_MAX_ATTEMPTS },
        });
        throw new AppError(50000, { reason: 'order_no_collision_exhausted' });
      }
      // 撞号静默重试不值得告警（6 位段同日撞一次属正常概率），但留 info 便于观察频率
      logger.info('order_no_collision_retry', { result: 'retry', ctx: { attempt } });
    }
  }
  // orderNo 在循环里必然被赋值或已抛出；TS 不能自证，显式收窄
  if (orderNo === undefined) throw new AppError(50000, { reason: 'order_no_unset' });

  // ── 8. 写 order_items（申报价值按行金额分摊，行之和 === toMinor(小计)）─────
  const usdRate = fxMap.get('USD');
  if (usdRate === undefined) {
    // assembleQuote 已把 USD 并入查询；到这里还没有 = fx_rates 真的没有 USD 行
    throw new AppError(50003, { currency: 'USD', reason: 'declared_value_needs_usd' });
  }
  const usdRateInt = toRateInt(usdRate);
  const lineAmounts = input.items.map((it) => {
    const p = products.find((x) => x.productId === it.productId);
    // summarizeQuoteItems 已保证每个 item 都有商品；找不到 = 代码 bug，响亮抛
    if (p === undefined) throw new AppError(50000, { reason: 'product_lost_mid_tx' });
    return p.priceJpy * it.qty;
  });
  const declaredTotal = toMinor(q.itemsJpy, usdRateInt);
  const declaredByLine = allocate(declaredTotal, lineAmounts);

  const itemRows: OrderItemInsertRow[] = input.items.map((it, i) => {
    const row = rows.find((r) => r.id === it.productId);
    if (row === undefined) throw new AppError(50000, { reason: 'product_lost_mid_tx' });
    return {
      id: `oi-${idGen.uuid()}`,
      order_id: orderId,
      product_id: it.productId,
      title_snapshot: row.title,
      qty: it.qty,
      unit_price_jpy: row.price_jpy,
      weight_g: row.weight_g,
      declared_value_usd: declaredByLine[i] ?? 0,
    };
  });
  await insertOrderItems(tx, itemRows);

  // ── 9. 审计事件（流 B：建单 100% 落 order_events）─────────────────────────
  await tx`
    insert into order_events (order_id, status, actor, at)
    values (${orderId}, 'created', ${`user:${input.userId}`}, ${clock.now()})
  `;

  logger.info('order_created', {
    order_id: orderId,
    result: 'ok',
    ctx: {
      item_count: input.items.length,
      total_jpy: q.totalJpy,
      weight_g: q.weightG,
      carrier,
      dest,
    },
  });
  return { orderId, orderNo, expiresAt, q, fxSnapshot };
}
