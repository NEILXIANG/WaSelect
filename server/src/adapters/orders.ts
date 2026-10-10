/**
 * 职责：`orders` 表的 SQL 仓储（I1-U2 起；U5 建单/查询会继续生长本文件）。
 *
 * 边界：只做 SQL 与行 ↔ 类型的映射，不含业务规则（状态机迁移表在 `domain/order.ts`，U5）。
 *
 * @why 关单扫描的两个 SQL 细节都是踩过坑才定下的，写在这里而不是散落在 job 里：
 *      ① `expires_at <= now`（**含等号**）——语义是"可支付窗口为 `[created, expires_at)`"：
 *         到点的这一瞬间就不可付了。mark-paid 守卫用**同一个**比较方向（`now >= expires_at` 即迟到），
 *         两边若一个含等号一个不含，"恰好在 expires_at 那一毫秒付款"的订单会同时被
 *         "关单 job 放过"和"落账守卫拒绝"，谁也解释不清它到底算不算超时。
 *      ② `FOR UPDATE SKIP LOCKED`——关单 job 与支付回调会**同时**盯上同一张单
 *         （用户在 29 分 59 秒付款、30 分 00 秒 tick 醒来）：
 *         行锁被落账事务持有时，扫描**跳过**这张单而不是整批卡死等锁；
 *         下一轮 tick 它若仍未支付自然会被再扫到。写成裸 `FOR UPDATE` 的后果是
 *         落账慢 5 秒、整批关单就堵 5 秒，且这种堵塞只在"快超时还在付"的真实场景才出现。
 *
 * @limitation 一：扫描限量（`LIMIT $3`）——单轮最多取 `limit` 条，剩余的**下一轮**再关。
 *              换来单轮事务时长有上界（D-43 进程内调度器，长事务会拖累整条连接池）；
 *              代价是积压时关单有延迟（每轮 60s × 每轮 limit 条），MVP 单量下可接受。
 * @limitation 二：`markOrderExpired` 的 WHERE 里重复了状态条件（不只靠扫描时的过滤）：
 *              扫描与更新之间若有人抢先改了状态（理论上同事务内不可能，但本函数也对
 *              事务外调用方开放），0 行命中 → 返回 false，调用方不得把它当错误。
 *
 * @see app/expire-orders.ts（消费方：超时关单 job）；migrations/001_init.sql（orders 表）；
 *      docs/I1阶段开发实施方案.md §3.2；D-33（30 分钟超时关单）
 */
import { AFTER_SALE_OPEN_STATUSES, ORDER_STATUS } from '@waselect/shared';
import type { Db, JSONValue } from './db.js';
import { PRODUCT_ID_LOCK_COLLATION } from '../domain/stock-lock.js';

/**
 * 可支付状态：只有这两个状态的订单会被超时关单。
 * @why 不从 shared 的 ORDER_STATUS 推导子集——"哪些状态算可支付"是**业务判定**，
 *      显式写出来比在枚举里做索引切片可读，且加状态（如 `price_review`）时
 *      这里是编译期会逼你想一遍的地方。
 */
export const PAYABLE_STATUSES = ['created', 'pending_payment'] as const;

/**
 * 锁定并取出"到点未支付"的订单 id（按 expires_at 升序：最老的先关）。
 *
 * @param now 判定基准——**调用方必须传本轮 tick 的 startedAt**（ports/scheduler.ts
 *            JobContext.startedAt 的 @why：同一轮里所有 job 用同一个基准，
 *            否则边界订单的命运取决于它在队列里排第几）。
 */
export async function lockExpiredPayableOrders(
  tx: Db,
  now: Date,
  limit: number,
  /**
   * 有在途支付（initiated 支付行）的单，到点后再等这么久才关（M-01）。
   * @why 窗口最后几秒付的款，支付通知往往晚几秒到；到点即关的话，回调撞上"已关单"只能判迟到付款，
   *      钱扣了、库存却被回补、可能被别人买走。发起支付与短链仍按 expires_at 截止，宽限期里不会产生新付款
   *      （宽限期里真的付了，回调按付款时刻判迟到，结论与原来相同）。
   */
  paymentGraceMs = 0,
): Promise<string[]> {
  const graceCutoff = new Date(now.getTime() - paymentGraceMs);
  const rows = await tx`
    select id from orders
     where status in ${tx([...PAYABLE_STATUSES])}
       and expires_at <= case
             when exists (select 1 from payments p
                           where p.order_id = orders.id and p.status = 'initiated')
               then ${graceCutoff}::timestamptz
             else ${now}::timestamptz
           end
     order by expires_at asc
     limit ${limit}
     for update skip locked
  `;
  return rows.map((r) => String(r.id));
}

/**
 * 把一张订单关为 `expired` 并写审计事件（同一事务）。
 *
 * @returns true = 本次真的关了（随后应 emit `order.expired` + 释放库存）；
 *          false = 状态已被别人抢先迁走（0 行命中，**不是错误**，见文件头 @limitation 二）。
 */
export async function markOrderExpired(tx: Db, orderId: string, at: Date): Promise<boolean> {
  const updated = await tx`
    update orders
       set status = 'expired', updated_at = now()
     where id = ${orderId}
       and status in ${tx([...PAYABLE_STATUSES])}
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, actor, at)
    values (${orderId}, 'expired', 'system', ${at})
  `;
  return true;
}

// ── 自动签收 / 自动完成（O-12 / AJ-182）──────────────────────────────────────

/**
 * 两段自动迁移的列映射（**白名单**：列名只能来自这张表，不接受调用方传入的字符串）。
 * @why 两段逻辑逐字相同，只差"从哪个状态、按哪一列计时、盖哪一列时间戳"——写两份 SQL
 *      迟早漂移（一份改了拒付排除、另一份没改）。列名走 `tx(identifier)` 转义，且只能是这里列出的值。
 */
const AUTO_ADVANCE = {
  delivered: { from: 'shipped', since: 'shipped_at', stamp: 'delivered_at' },
  completed: { from: 'delivered', since: 'delivered_at', stamp: 'completed_at' },
} as const;

/**
 * 把到期的订单自动迁到下一态，并逐单记 order_events（actor = system）。**一条语句**完成选取、迁移、记事件。
 * @param dueBefore 计时列 ≤ 它即到期（含等号：恰好满 N 天算到期，与关单 expires_at 同口径）
 * @param at 迁移时刻（写进时间戳列与事件；来自注入时钟）
 * @returns 本次真正迁走的订单 id
 * @why 排除 `has_dispute`：拒付未决时"签收 / 完成"会关掉售后与举证窗口，那要人判断（AJ-182）。
 * @why 排除有**进行中售后**（open / processing）的单（AJ-424，统一结论 5.1）：买家报了"没收到 / 破损"、运营还没结案时，
 *      系统替他"签收 / 完成"会让两边看到的进度互相矛盾。结案后下一轮照常推进（计时列不重置——到期就迁）。
 *      "进行中"取 shared `AFTER_SALE_OPEN_STATUSES`，与部分唯一索引 `uq_after_sale_requests_open` 同口径，不在这里另写一份。
 * @why `for update skip locked` + 迁移时再判一次 `status`：与关单同口径——并发的人工操作（退款、发货改址）
 *      持着行锁时本轮跳过它，下一轮再看；已被别人迁走的行 0 命中，不写事件。
 */
export async function autoAdvanceOrders(
  tx: Db,
  to: keyof typeof AUTO_ADVANCE,
  opts: { dueBefore: Date; at: Date; note: string; limit: number },
): Promise<string[]> {
  const m = AUTO_ADVANCE[to];
  const rows = await tx<{ id: string }[]>`
    with due as (
      select id from orders
       where status = ${m.from} and has_dispute = false and ${tx(m.since)} <= ${opts.dueBefore}
         and not exists (
           select 1 from after_sale_requests a
            where a.order_id = orders.id and a.status in ${tx([...AFTER_SALE_OPEN_STATUSES])}
         )
       order by ${tx(m.since)}
       limit ${opts.limit}
       for update skip locked
    ), moved as (
      update orders o set status = ${to}, ${tx(m.stamp)} = ${opts.at}, updated_at = now()
        from due where o.id = due.id and o.status = ${m.from}
      returning o.id
    ), ev as (
      insert into order_events (order_id, status, note, actor, at)
      select id, ${to}, ${opts.note}, 'system', ${opts.at} from moved
    )
    select id from moved
  `;
  return rows.map((r) => r.id);
}

// ── I1-U5b：建单 / 库存 ─────────────────────────────────────────────────────

/**
 * 建单快照用的地址行（普通对象，见 findOwnedAddress 的 ⚠️）。
 * @why 用 `type` 不用 `interface`：它要作为 `OrderInsertRow.address_snapshot`（JSONValue）
 *      传给 `tx.json()`，而 JSONValue 的对象成员要求索引签名——interface 没有隐式
 *      索引签名（TS 对 interface 的既定行为），对象字面量 type 有。两者在取值层面等价。
 */
export type OrderAddressSnapshot = {
  id: string;
  recipient: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
};

/**
 * 读取一张**确定属于该用户**的地址（建单快照的来源）。
 * @returns 地址行；不存在或非本人 → null（路由层判 40400，与订单归属同口径）。
 *
 * ⚠️ 必须**逐字段取值**返回普通对象，不能把 postgres.js 的行直接给 JSON.stringify：
 *    驱动的 Row 是**数组子类**（列名挂在命名属性上），`JSON.stringify(Row)` 只序列化
 *    数字索引 → 恒为 `'[]'`——快照落成空数组且**不报错**（接线测试实抓一次：
 *    address_snapshot.recipient 读回 undefined）。
 */
export async function findOwnedAddress(
  tx: Db,
  addressId: string,
  userId: string,
): Promise<OrderAddressSnapshot | null> {
  const rows = await tx`
    select id, recipient, phone, line1, line2, city, state, postal_code, country
      from addresses where id = ${addressId} and user_id = ${userId}
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: String(r.id),
    recipient: String(r.recipient),
    phone: String(r.phone),
    line1: String(r.line1),
    line2: r.line2 === null ? null : String(r.line2),
    city: String(r.city),
    state: String(r.state),
    postal_code: String(r.postal_code),
    country: String(r.country),
  };
}

/**
 * 原子扣减库存（条件更新）：`stock >= qty` 才扣，一行都不满足则返回 false。
 *
 * @why 这是并发安全的**唯一**正确形态：先 SELECT 余量再 UPDATE 的写法，在两个请求
 *      同时买最后一件时，两边都读到 1、都扣成功 → 超卖（-1 被 CHECK 拦住时则是一边 500）。
 *      条件更新把"判定 + 扣减"压进一条语句，数据库用行锁保证只有一个成功者。
 *      建单事务里逐行调用：任一商品 false → 抛 40901 整单回滚（前面已扣的随行回滚）。
 *
 * @why ⚠️ **不写 `updated_at`**（DB3-02 / AJ-258）。`products.updated_at` 有两个消费方：
 *      管理端列表的排序键（`catalog-admin.ts` 的 `order by updated_at desc, id`），
 *      以及 ADM3-02 起商品 PUT 的**乐观锁凭据**。而库存是**并发写的实时余额**，不是商品信息：
 *      ① 排序：买家下一单就把那件商品顶到列表第一位，运营翻页时整体位移 → 漏行 + 重行；
 *      ② 乐观锁：运营正在编辑时来一单，凭据当场失效，"只改标题保存"被 40914 拒掉——
 *         而"编辑期间买家下单仍能保存、且不覆盖库存"是 AJ-175 **专门实现并钉住**的行为。
 *      所以本函数与 {@link incrementStock} 只动 `stock`。
 *      @tradeoff 代价：`updated_at` 不再等于"这一行最后被写的时刻"（字面意义的 update）。
 *              换来的是"买家行为不会作废运营的工作"；库存的变动时刻本就没落在任何列上，
 *              需要时由 `order_events` 回答（按订单查，而不是按商品查）。
 * @see {@link incrementStock}（对称，同样不写 updated_at）
 */
export async function decrementStock(tx: Db, productId: string, qty: number): Promise<boolean> {
  // `status = 'active'` 进同一条条件更新（工程缺口第二轮复核）：建单先不加锁读快照、再算报价、最后扣减，
  // READ COMMITTED 下中间若有人下架并提交，不带这一条就会把已下架（可能是合规停售）的商品扣成订单。
  const rows = await tx`
    update products set stock = stock - ${qty}
     where id = ${productId} and stock >= ${qty} and status = 'active'
  `;
  return rows.count > 0;
}

/**
 * 原子增加库存（回补）。与 {@link decrementStock} 对称，但不带条件——
 * 回补不该有"加不进去"的情形（库存上限不是这个阶段的概念）。
 *
 * @why 同样**不写 `updated_at`**：理由与 {@link decrementStock} 完全一致（DB3-02）。
 *      关单 job 每 60 秒回补一次，若这里刷新 `updated_at`，被回补的商品会持续
 *      在管理端列表里"浮上来"，运营的翻页与编辑凭据都在持续失效。
 */
export async function incrementStock(tx: Db, productId: string, qty: number): Promise<void> {
  await tx`
    update products set stock = stock + ${qty}
     where id = ${productId}
  `;
}

/**
 * 取一批订单里要回补的（商品, 数量），**按取锁顺序排好**（见 `domain/stock-lock.ts`）。
 *
 * @why 同一个商品在一批单里出现多次要先 `sum` 再回补：逐单逐行调用会把锁
 *      获取序列变成"每单内升序的串接"（A: a,c 然后 B: b → 序列 a,c,b），
 *      那**不是**一个全局升序——只要两个事务的串接断点不同就可能成环
 *      （T1: a,c,b 持 a,c 等 b；T2: b,a,c 持 b 等 a → 40P01）。
 *      汇总后一次性按序走，序列才是真正的全局升序。
 * @why `collate "C"` 必须显式写（不能靠库的默认排序规则）：见 `domain/stock-lock.ts` 文件头。
 */
export async function stockRestorePlan(
  tx: Db,
  orderIds: readonly string[],
): Promise<readonly { productId: string; qty: number }[]> {
  if (orderIds.length === 0) return [];
  // ⚠️ collation 不能参数化（PG 不接受 $1 当 collation 名），只能拼接；
  //    值来自本模块导入的常量，不是用户输入（postgres.js 的 unsafe 会绕过参数化，故在此集中一处）
  const rows = await tx.unsafe(
    `select product_id, sum(qty)::int as qty
       from order_items
      where order_id = any($1::text[])
      group by product_id
      order by product_id collate "${PRODUCT_ID_LOCK_COLLATION}"`,
    [orderIds as unknown as string[]],
  );
  return rows.map((r: Record<string, unknown>) => ({
    productId: String(r['product_id']),
    qty: Number(r['qty']),
  }));
}

/**
 * 按订单行项目恢复库存（关单/取消的释放）。
 *
 * @why **按取锁顺序逐行加**，而不是一条 `update … from order_items`：后者一次更新多行，
 *      行锁的获取顺序由**执行计划**决定（小表 Seq Scan + Nested Loop 与走索引时的顺序可以相反），
 *      与建单那条"按序扣减"的路径形成 AB / BA → PG 40P01 死锁 → 非 AppError → 50000。
 *      @measured（全量审查 ORD 分片探针, 2026-09-29）：两种执行计划下都复现过 `deadlock detected`。
 *
 * ⚠️ **本函数不幂等**：调一次加一次。调用方必须用"状态迁移守卫"保证只调一次——
 *    `markOrderExpired` / cancel 的 update 带状态条件返回 true 的那一刻，
 *    就是"本次迁移是我干的"的排他凭证，释放跟在它后面（同事务）。
 *    脱离守卫直接调用 = 库存双倍回血（钱货两空的另一种形态）。
 *
 * @returns 受影响的行数（= 涉及的商品种类数）。
 */
export async function restoreStockForOrder(tx: Db, orderId: string): Promise<number> {
  return restoreStockForOrders(tx, [orderId]);
}

/**
 * 批量回补：多张单一起关时**必须**走这里，逐单调 {@link restoreStockForOrder} 是错的。
 *
 * @why 关单 job 在一个事务里跨多张单回补。逐单调用时，总锁序是"每单内升序"的串接，
 *      不是全局升序——两个批次只要串接断点不同就可能成环（见 `stockRestorePlan` 的 @why）。
 *      汇总后按序走，死锁才真的被消除，而不是"每单内碰巧有序"。
 * @returns 受影响的行数（= 涉及的商品种类数，不是订单数）。
 */
export async function restoreStockForOrders(tx: Db, orderIds: readonly string[]): Promise<number> {
  const plan = await stockRestorePlan(tx, orderIds);
  for (const row of plan) {
    await incrementStock(tx, row.productId, row.qty);
  }
  return plan.length;
}

/**
 * insertOrder 的行。
 * @why JSONB 列传 **JS 对象**、写入用 `tx.json()`——`${字符串}::jsonb` 会被驱动按
 *      推断出的 jsonb 参数类型**再 JSON 编码一次**（双重编码：列里存的是字符串标量，
 *      SQL 侧 `->>` 提取一律 null；读侧全靠驱动解析+调用方 JSON.parse 双重解码才
 *      "看起来正常"——U6a 探针实锤，见 jsonbValue 的 ⚠️）。
 *      类型上用驱动的 `JSONValue` 而不是 `unknown`：`tx.json()` 的签名就只收 JSONValue，
 *      这里把"必须可 JSON 序列化"的约束交给编译器，而不是运行时才被序列化失败咬到。
 */
export interface OrderInsertRow {
  id: string;
  order_no: string;
  user_id: string;
  items_jpy: number;
  shipping_jpy: number;
  /** null = 关税无法估算（W-05 / 迁移 026），不是 0。 */
  duty_jpy: number | null;
  total_jpy: number;
  weight_g: number;
  fx_snapshot: JSONValue;
  address_snapshot: JSONValue;
  contact_email: string | null;
  terms_version: string;
  expires_at: Date;
  /** 审核期测试单（技术文档 §2.9 / AJ-179）：建单时 REVIEW_MODE=on 即 true；管理端默认过滤、不得采购发货。 */
  is_test: boolean;
}

/**
 * 插入订单主行（status='created'）。
 * @throws {PostgresError} 23505（order_no 唯一冲突）——**调用方必须 savepoint 捕获重试**（D32）：
 *         PG 事务内一条语句报错后整个事务进入 aborted 状态，不回滚到 savepoint 就什么都不能再做。
 */
export async function insertOrder(tx: Db, row: OrderInsertRow): Promise<void> {
  await tx`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, contact_email,
                        terms_version, expires_at, is_test)
    values (${row.id}, ${row.order_no}, ${row.user_id}, 'created', ${row.items_jpy},
            ${row.shipping_jpy}, ${row.duty_jpy}, ${row.total_jpy}, ${row.weight_g},
            ${tx.json(row.fx_snapshot)}, ${tx.json(row.address_snapshot)}, ${row.contact_email},
            ${row.terms_version}, ${row.expires_at}, ${row.is_test})
  `;
}

/**
 * 订单是否审核期测试单（自动确认的第二道防线，AJ-179）。
 * @returns null = 订单不存在。
 */
export async function isTestOrder(db: Db, orderId: string): Promise<boolean | null> {
  const rows = await db<{ is_test: boolean }[]>`select is_test from orders where id = ${orderId}`;
  const row = rows[0];
  return row === undefined ? null : row.is_test;
}

/**
 * order_items 一行（declared_value_usd 由建单用 allocate 分摊好——这里只负责落库）。
 *
 * @why 后三列是**采购快照**（迁移 021 / D-39）：`title_ja` / `jan_code` / `purchase_source`。
 *      它们与 `title_snapshot` / `unit_price_jpy` 同一条口径——**下单那一刻**的商品信息，
 *      不是当前值。管理端的"待采购清单"照这三列去采购，所以商品改了采购渠道之后
 *      这些列**不能跟着变**（JOIN `products` 会让历史订单的渠道被悄悄改写，且不报错）。
 * @why 类型为 `string | null` 且**必填键**（不是可选）：调用方（建单）必须显式给一个值，
 *      哪怕是 null。写成可选键的话，"忘了传"与"商品确实没有 JAN 码"在代码里长得一样，
 *      而前者是 bug、后者是事实——用必填键逼调用方做这个区分。
 */
export interface OrderItemInsertRow {
  id: string;
  order_id: string;
  product_id: string;
  title_snapshot: string;
  qty: number;
  unit_price_jpy: number;
  weight_g: number;
  declared_value_usd: number;
  title_ja: string | null;
  jan_code: string | null;
  purchase_source: string | null;
  cost_jpy: number | null;
  hs_code: string | null;
  customs_desc_en: string | null;
}

export async function insertOrderItems(
  tx: Db,
  items: readonly OrderItemInsertRow[],
): Promise<void> {
  // line_no = 数组下标 + 1：调用方按买家下单顺序传入（create-order 用 input.items 原序，
  // 不是取锁用的排序后数组），读取按它排（迁移 029）
  for (const [i, it] of items.entries()) {
    await tx`
      insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy,
                               weight_g, declared_value_usd,
                               title_ja, jan_code, purchase_source,
                               cost_jpy, hs_code, customs_desc_en, line_no)
      values (${it.id}, ${it.order_id}, ${it.product_id}, ${it.title_snapshot}, ${it.qty},
              ${it.unit_price_jpy}, ${it.weight_g}, ${it.declared_value_usd},
              ${it.title_ja}, ${it.jan_code}, ${it.purchase_source},
              ${it.cost_jpy}, ${it.hs_code}, ${it.customs_desc_en}, ${i + 1})
    `;
  }
}

// ── I1-U5c：查询 / 取消 ─────────────────────────────────────────────────────

/**
 * jsonb 列读出归一化：对象直通；字符串再 JSON.parse 一次。
 *
 * ⚠️ 真实机制（U6a 探针实锤，推翻 U5b 的"驱动未注册解析器"误判）：
 *    本仓库的 postgres.js **会解析 jsonb**（对象列读回就是 JS object）。
 *    读回 string 的唯一原因是**写侧双重编码**——旧写法 `${JSON文本}::jsonb`
 *    让驱动按推断的 jsonb 参数类型把字符串再 JSON 编码一遍，列里存的是
 *    **字符串标量**（SQL 侧 `->>` 提取 null，是它最毒的表现：静默丢数据不报错）。
 *    正确写法是 `tx.json(obj)`（insertOrder 已改）；本分支只为兼容
 *    修复前已落库的双重编码行（dev/测试库），新数据不会走到。
 */
function jsonbValue(raw: unknown): unknown {
  return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
}

/** 我的订单列表行（fx_snapshot 已 JSON.parse，见 jsonbValue 的 ⚠️）。 */
export interface OrderListRow {
  id: string;
  order_no: string;
  status: string;
  total_jpy: number;
  fx_snapshot: unknown;
  created_at: Date;
}

/**
 * 买家列表行 = 摘要 + 件数 + 第一行商品的现图（AJ-408 / 契约 0.6.49，M-11）。
 * @why 单独一个类型而不是往 `OrderListRow` 上加：`OrderListRow` 也是详情主行的基类，
 *      详情响应**不**带这两列（契约只加在列表行）。
 */
export interface OwnedOrderListRow extends OrderListRow {
  /** 各行 qty 之和（"共 N 件"，不是行数）。 */
  item_count: number;
  /** 第一行（line_no 最小）商品的 `products.images`（已 JSON.parse）；没有行项目 → null。 */
  first_images: unknown;
  /**
   * 第一行的**下单快照**标题（`order_items.title_snapshot`，A8 / AJ-416，契约 0.6.54）；没有行项目 → null。
   * @why 快照而不是商品现名：列表是"我买过什么"，店家改名后列表还得认得出当时买的那件（与详情行项目同口径）。
   */
  first_title: string | null;
  /**
   * 售后状态（AJ-430，契约 0.6.60）：有进行中（open / processing）的申请 → 'open'；只有已结案的 → 'closed'；没有 → null。
   * @why 小程序「售后·退款」页签要能找到"有售后、但订单状态仍是已送达 / 已完成"的单；"进行中"取 shared
   *      `AFTER_SALE_OPEN_STATUSES`，与自动签收（AJ-424）、管理端待办（AJ-425）同口径。
   */
  after_sale_state: 'open' | 'closed' | null;
  /**
   * 付款截止（AJ-435，契约 0.6.61）：与详情同一列 `orders.expires_at`（NOT NULL）。
   * @why 小程序待付款行写明"几点前付款"——原先只说"请在截止时间前完成支付"，却不说截止是几点。
   */
  expires_at: Date;
}

/**
 * 列出本人的订单（按 created_at 倒序）；`statuses` 给了就只取这些状态（任一命中）。
 *
 * @why 归属过滤进 WHERE 而不是拉回内存再滤：漏写 `user_id=` 时前者是"返回空"，
 *      后者是"把别人的单给了这个用户"——过滤位置选错了就是越权读取。
 * @why 多状态用 `status in (…)`（AJ-408）：与管理端 `listAdminOrders` 同一写法；
 *      空数组不会走到这里（shared `parseOrderStatusList` 对空串返回 null → 路由 40001）。
 * @why 件数与首图用**相关子查询**而不是 join + group by：列表行只要"一个数 + 一张图"，
 *      join 会把每单的行项目全展开再折回来，还得为首图另写窗口函数；子查询各取所需，
 *      且 `order_items(order_id)` 有外键索引（db.db.test 结构不变量保证）。
 * @why 首图取**第一行**（`line_no` = 买家下单顺序，迁移 029；与详情 `listOrderItemsWithImage` 同一排序）
 *      而不是"第一张有图的"：列表缩略图要代表"这单买的第一样东西"，跳着找图会让缩略图与
 *      详情第一行对不上；第一行没图就由前端显示占位图（AJ-408 ④）。
 * @why 件数 `::int`：@measured: 本库 `coalesce(sum(qty),0)::int` 读回 `{"s":3}` typeof number；
 *      空集读回 `{"s":0}`（2026-10-08 探针，test 库）。不 cast 时 sum(int) 是 bigint，
 *      驱动对 bigint 的映射取决于连接配置——显式 cast 不赌配置。
 * @limitation 无分页：契约 GET /orders 没有 page/size 参数（MVP 单量下全量返回；
 *              /admin/orders 才有分页）。单用户订单数真成问题的那天，先改契约再加。
 * @limitation 首图是商品**现图**（同详情行项目的 @why：图是展示素材不是交易事实）。
 */
export async function listOwnedOrders(
  db: Db,
  userId: string,
  statuses?: readonly string[],
): Promise<OwnedOrderListRow[]> {
  const rows = await db`
    select o.id, o.order_no, o.status, o.total_jpy, o.fx_snapshot, o.created_at, o.expires_at,
           (select coalesce(sum(oi.qty), 0)::int from order_items oi where oi.order_id = o.id)
             as item_count,
           (select p.images from order_items oi join products p on p.id = oi.product_id
             where oi.order_id = o.id
             order by oi.line_no nulls last, oi.id
             limit 1) as first_images,
           (select oi.title_snapshot from order_items oi
             where oi.order_id = o.id
             order by oi.line_no nulls last, oi.id
             limit 1) as first_title,
           case
             when exists (select 1 from after_sale_requests a
                           where a.order_id = o.id and a.status in ${db([...AFTER_SALE_OPEN_STATUSES])}) then 'open'
             when exists (select 1 from after_sale_requests a where a.order_id = o.id) then 'closed'
           end as after_sale_state
      from orders o
     where o.user_id = ${userId}
       and ${statuses === undefined ? db`true` : db`o.status in ${db([...statuses])}`}
     order by o.created_at desc
  `;
  return rows.map((r) => ({
    id: String(r.id),
    order_no: String(r.order_no),
    status: String(r.status),
    total_jpy: Number(r.total_jpy),
    fx_snapshot: jsonbValue(r.fx_snapshot),
    created_at: r.created_at as Date,
    item_count: Number(r.item_count),
    first_images: r.first_images === null ? null : jsonbValue(r.first_images),
    first_title: typeof r.first_title === 'string' ? r.first_title : null,
    after_sale_state:
      r.after_sale_state === 'open' || r.after_sale_state === 'closed' ? r.after_sale_state : null,
    expires_at: r.expires_at as Date,
  }));
}

/** 订单详情主行（address_snapshot 已 JSON.parse）。 */
export interface OrderDetailRow extends OrderListRow {
  items_jpy: number;
  shipping_jpy: number;
  /** null = 关税无法估算（W-05 / 迁移 026），不是 0。 */
  duty_jpy: number | null;
  contact_email: string | null;
  terms_version: string;
  expires_at: Date;
  address_snapshot: unknown;
  carrier: string | null;
  tracking_no: string | null;
}

/**
 * 读取一张**确定属于该用户**的订单主行。
 * @returns 非本人与不存在同返回 null——路由层判 40400，
 *          防存在性探测（与 findOwnedAddress 同一判断，U5b 定）。
 */
export async function findOwnedOrder(
  db: Db,
  orderId: string,
  userId: string,
): Promise<OrderDetailRow | null> {
  const rows = await db`
    select id, order_no, status, items_jpy, shipping_jpy, duty_jpy, total_jpy,
           fx_snapshot, address_snapshot, contact_email, terms_version,
           carrier, tracking_no, expires_at, created_at
      from orders where id = ${orderId} and user_id = ${userId}
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: String(r.id),
    order_no: String(r.order_no),
    status: String(r.status),
    items_jpy: Number(r.items_jpy),
    shipping_jpy: Number(r.shipping_jpy),
    duty_jpy: r.duty_jpy === null ? null : Number(r.duty_jpy),
    total_jpy: Number(r.total_jpy),
    fx_snapshot: jsonbValue(r.fx_snapshot),
    address_snapshot: jsonbValue(r.address_snapshot),
    contact_email: r.contact_email === null ? null : String(r.contact_email),
    terms_version: String(r.terms_version),
    carrier: r.carrier === null ? null : String(r.carrier),
    tracking_no: r.tracking_no === null ? null : String(r.tracking_no),
    expires_at: r.expires_at as Date,
    created_at: r.created_at as Date,
  };
}

/**
 * **只判归属**：这张单是不是这个用户的（ADM3-01 纵深防御 / AJ-290）。
 *
 * @returns 属于 → true；不属于 / 单不存在 → **同为** false。
 * @why 不加 `for update`：**订单的 `user_id` 建单后不再变**（没有改归属的写入路径），
 *      所以"读到的归属"与"几毫秒后的归属"是同一个答案，持锁换不来任何额外的正确性，
 *      只会把这条只读核对变成与落账 / 关单事务抢锁的一处新争用点。
 * @why 不区分"不存在"与"属于别人"：两者的**处置动作相同**（关掉面板、回列表重新点"处理"），
 *      分开只会多一个错误码与多一条契约，换不来不同的下一步动作。
 *      ⚠️ 与 `findOwnedOrder` 的"同码防探测"是**同一个判据的两处复用**，
 *      但那里是为了不泄露"这张单存在但不属于你"（买家侧），这里是管理端的可信调用方。
 *
 * @see app/block-user.ts（唯一调用方：封号**之前**的凭据核对）
 */
export async function orderBelongsToUser(
  db: Db,
  orderId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db`select 1 as hit from orders where id = ${orderId} and user_id = ${userId}`;
  return rows.length > 0;
}

/**
 * 取消路径的第一步：**持行锁**读 {id,status}（FOR UPDATE）。
 * @why 取消 = 锁单 → 判迁移 → 迁移 + 作废支付行 + 释放库存，全在一个事务里；
 *      不持锁的话，"判完 created"与"改 cancelled"之间落账事务可以把单迁成 paid——
 *      锁从读取那一刻起就把这个窗口焊死（mark-paid 同样 FOR UPDATE，谁先到谁赢）。
 */
export async function lockOwnedOrderForCancel(
  tx: Db,
  orderId: string,
  userId: string,
): Promise<{ id: string; status: string } | null> {
  const rows = await tx`
    select id, status from orders where id = ${orderId} and user_id = ${userId} for update
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return { id: String(r.id), status: String(r.status) };
}

/** 订单行项目（含商品现图；images 已 JSON.parse）。 */
export interface OrderItemReadRow {
  product_id: string;
  title_snapshot: string;
  qty: number;
  unit_price_jpy: number;
  images: unknown;
}

/**
 * 订单的行项目 + 商品现图。
 * @why 图从 products 现查而不是落进快照：图是**展示素材**不是交易事实，
 *      换图不该改历史订单的"内容"，但商品页改版后订单页不该还显示死链旧图。
 *      INNER JOIN 安全：order_items.product_id 有外键，商品物理删除会被挡（只能下架）。
 */
export async function listOrderItemsWithImage(
  db: Db,
  orderId: string,
): Promise<OrderItemReadRow[]> {
  const rows = await db`
    select oi.product_id, oi.title_snapshot, oi.qty, oi.unit_price_jpy, p.images
      from order_items oi join products p on p.id = oi.product_id
     where oi.order_id = ${orderId}
     order by oi.line_no nulls last, oi.id
  `;
  return rows.map((r) => ({
    product_id: String(r.product_id),
    title_snapshot: String(r.title_snapshot),
    qty: Number(r.qty),
    unit_price_jpy: Number(r.unit_price_jpy),
    images: jsonbValue(r.images),
  }));
}

/**
 * **买家**订单时间线（order_events 按 at 升序，**只取订单状态值**）。
 *
 * @why `order_events` 同时承载两类行：状态迁移（10 态，契约 OrderStatus）与管理事件
 *      （`address_changed` / `dispute_opened` / `dispute_closed` / `refund_failed`，actor 为管理员或机构）。
 *      曾经不加过滤：买家订单详情里出现"状态未知"行，且**拒付开案/结案被买家看见**
 *      （一致性审计 C2，AJ-176 实测）。管理端详情走 `listEventsFor`，仍看全量。
 * @tradeoff 过滤写在 SQL（`= any(ORDER_STATUS)`）而不是前端：外泄面在服务端收口，
 *           小程序与将来的日文站不必各自再过滤一遍。
 */
export async function listOrderTimeline(
  db: Db,
  orderId: string,
): Promise<{ status: string; at: Date }[]> {
  const rows = await db`
    select status, at from order_events
     where order_id = ${orderId} and status = any(${[...ORDER_STATUS]})
     order by at asc, id asc
  `;
  return rows.map((r) => ({ status: String(r.status), at: r.at as Date }));
}

/** 最新一条支付行的展示摘要（契约 Order.payment 的形状）。 */
export interface OrderPaymentSummary {
  provider: string;
  status: string;
  charge_currency: string;
  charge_amount: number;
  paid_amount: number | null;
  paid_currency: string | null;
}

/**
 * 取订单最新一条 payments 行（换通道重发后旧行不该盖新行，按 created_at desc 取一）。
 * @why 先排除已作废（cancelled）再比时间（工程缺口第二轮复核）：`created_at` 默认 `now()` 是**事务开始**时刻，
 *      并发换通道时后拿到锁的一方新插的行时间反而更早，而被它作废的旧行更晚——只按时间取，
 *      买家详情就显示那笔已作废的（币种、金额都不对），付款成功后仍是。全部已作废时照常取最新一条。
 * @limitation "最新"指的是我方登记时间——机构侧的真实先后以回调为准（落账在 mark-paid）。
 */
export async function findLatestPaymentSummary(
  db: Db,
  orderId: string,
): Promise<OrderPaymentSummary | null> {
  const rows = await db`
    select provider, status, charge_currency, charge_amount, paid_amount, paid_currency
      from payments where order_id = ${orderId}
      order by (status = 'cancelled') asc, created_at desc
      limit 1
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    provider: String(r.provider),
    status: String(r.status),
    charge_currency: String(r.charge_currency),
    charge_amount: Number(r.charge_amount),
    paid_amount: r.paid_amount === null ? null : Number(r.paid_amount),
    paid_currency: r.paid_currency === null ? null : String(r.paid_currency),
  };
}

/**
 * 锁住某用户**所有**在途单（`created` / `pending_payment`），按 id 升序返回。
 *
 * @why 为 B28（拉黑连带取消）而加：拉黑要在一个事务里把该用户手上**全部**在途单关掉，
 *      逐张查再逐张锁会把"哪些单算这一批"变成两个时刻的两个结果——
 *      中间新发起的支付会漏掉，而漏掉的正是"刚发起、还没付"的那一批。
 * @why 一批行要**一次**锁齐、且顺序确定：逐张查再逐张锁会把"哪些单算这一批"
 *      变成两个时刻的两个结果。顺序本身只要**对本函数稳定**即可（升序取 id 是
 *      "与业务无关但确定"的最小选择）。
 *
 * ⚠️ **这里的序与关单 job 不同，目前不死锁只因为一个隐性前提**（C3 第五轮重读发现，
 *    2026-10-02）：关单侧是 `order by expires_at`（要"最老的先关"，有业务含义），
 *    这里是 `order by id`——两个不同的全局序正是 AB/BA 的定义。此刻安全，是因为
 *    {@link lockExpiredPayableOrders} 用的是 **`FOR UPDATE SKIP LOCKED`**：
 *    它遇到已被本函数锁住的行会**跳过**而不是等待，于是"等待"只可能单向发生。
 *    ⚠️ 这个前提**没有测试钉住**——谁把关单侧的 `skip locked` 去掉（比如为了让
 *    "积压时不跳过"），这条路径就立刻变成真实的 40P01 → 非 AppError → 50000，
 *    而且只在"某个用户的多张在途单 id 序与过期序相反、且恰好与一轮 tick 撞上"时出现。
 *    @limitation 不改成与关单同序（如 `order by expires_at, id`）：那会让本函数
 *    背上一个它不需要的业务含义（"按过期时间处理"），而真正该修的是把
 *    "批量锁 orders 的序必须唯一"这条约束显式化——见 `domain/` 里 stock-lock
 *    对 products 做的那一次（回补与扣减共用同一个 comparator）。
 *    本条按"如实记录 + 标注前提"处理，不为此改动行为（MVP 下单用户多张在途单
 *    本就是少数，且拉黑是管理员的低频动作）。
 * @limitation 只锁在途单：`paid` 及之后的单**不碰**——已付的钱只能走退款链路，
 *              取消已付单在迁移表层面本来就不可达（paid → cancelled 不在表里）。
 */
export async function lockPayableOrdersOfUser(tx: Db, userId: string): Promise<string[]> {
  const rows = await tx`
    select id from orders
     where user_id = ${userId}
       and status in ${tx([...PAYABLE_STATUSES])}
     order by id
       for update
  `;
  return rows.map((r) => String(r['id']));
}

/**
 * 把一张订单关为 `cancelled` 并写审计事件（同一事务；与 markOrderExpired 同构）。
 *
 * @param actor 写进 `order_events.actor`（B28 起显式传入）。
 *      @why 曾经在这里写死 `user:${userId}`，于是"风控拉黑连带取消"在订单时间线上
 *          显示成**用户自己取消的**——审计时答不出"是谁把这张单关掉的"，
 *          而拉黑恰恰是最需要追责的动作（不可逆、影响真人）。
 *          两个调用方各自传自己的 actor，比在本函数里猜调用方是谁可靠。
 *
 * @returns true = 本次真的迁了（随后应作废旧支付行 + 释放库存 + emit order.cancelled）；
 *          false = 0 行命中（非本人 / 不存在 / 状态已被抢先迁走——**不是错误**）。
 * @why WHERE 里同时带 user_id 与状态条件：归属与迁移合法性**都**交给数据库判定，
 *      应用层先查再改会留 TOCTOU 窗口（lockOwnedOrderForCancel 已持锁时本条件是纵深，
 *      与 markOrderExpired @limitation 二同一判断）。
 */
export async function markOrderCancelled(
  tx: Db,
  orderId: string,
  userId: string,
  at: Date,
  actor: string,
  /** 管理端取消的原因（AJ-386）；买家取消 / 拉黑连带取消不传。 */
  note: string | null = null,
): Promise<boolean> {
  const updated = await tx`
    update orders
       set status = 'cancelled', cancelled_at = ${at}, updated_at = now()
     where id = ${orderId}
       and user_id = ${userId}
       and status in ${tx([...PAYABLE_STATUSES])}
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'cancelled', ${note}, ${actor}, ${at})
  `;
  return true;
}

/**
 * 作废订单的在途支付行（initiated → cancelled），返回作废条数（0 或 1）。
 * @why 只动 initiated：succeeded 的钱必须走退款链路（/admin/orders/{id}/refund，I2），
 *      取消一张已支付的订单改支付行 = 把钱改成"没收过"。
 *      部分唯一索引 `uq_payments_one_initiated` 保证在途至多一条，返回值就是 0/1。
 */
export async function voidInitiatedPayment(tx: Db, orderId: string): Promise<number> {
  const rows = await tx`
    update payments set status = 'cancelled'
     where order_id = ${orderId} and status = 'initiated'
  `;
  return rows.count;
}

// ── I1-U6a：支付意图 / 短链 ──────────────────────────────────────────────────

/** 发起支付要读的订单字段（一次 FOR UPDATE 取全，不再二查）。 */
export interface OrderPayRow {
  id: string;
  order_no: string;
  status: string;
  total_jpy: number;
  expires_at: Date;
  fx_snapshot: unknown;
  /** 目的国（从 address_snapshot jsonb 里提取；建单时地址快照即真相）。 */
  dest_country: string | null;
  /** 地址快照整体（发起支付时附给机构做风控 / 拒付举证，D-60①；AJ-176）。 */
  address_snapshot: unknown;
}

/**
 * 发起支付的第一步：**持行锁**读订单（并发支付/关单/取消互斥）。
 * @why 目的国从 `address_snapshot->>'country'` 取而不是查 country_profiles：
 *      这张单发往哪是**下单时已固定的事实**；全局"当前唯一活跃国家"是报价期的
 *      解析口径，支付期若运营改了配置，老单的目的国不能跟着变。
 */
export async function lockOwnedOrderForPay(
  tx: Db,
  orderId: string,
  userId: string,
): Promise<OrderPayRow | null> {
  const rows = await tx`
    select id, order_no, status, total_jpy, expires_at, fx_snapshot, address_snapshot,
           address_snapshot->>'country' as dest_country
      from orders where id = ${orderId} and user_id = ${userId}
      for update
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: String(r.id),
    order_no: String(r.order_no),
    status: String(r.status),
    total_jpy: Number(r.total_jpy),
    expires_at: r.expires_at as Date,
    fx_snapshot: jsonbValue(r.fx_snapshot),
    dest_country: r.dest_country === null ? null : String(r.dest_country),
    address_snapshot: jsonbValue(r.address_snapshot),
  };
}

/** 在途支付意图行（uq_payments_one_initiated 保证至多一条）。 */
export interface InitiatedPaymentRow {
  id: string;
  provider: string;
  provider_ref: string | null;
  charge_currency: string;
  charge_amount: number;
  pay_url: string | null;
}

/** 取订单的在途支付意图（复用/换通道判定的来源）；无 → null。 */
export async function findInitiatedPayment(
  db: Db,
  orderId: string,
): Promise<InitiatedPaymentRow | null> {
  const rows = await db`
    select id, provider, provider_ref, charge_currency, charge_amount, pay_url
      from payments where order_id = ${orderId} and status = 'initiated'
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: String(r.id),
    provider: String(r.provider),
    provider_ref: r.provider_ref === null ? null : String(r.provider_ref),
    charge_currency: String(r.charge_currency),
    charge_amount: Number(r.charge_amount),
    pay_url: r.pay_url === null ? null : String(r.pay_url),
  };
}

/**
 * 首次发起支付：created → pending_payment（写审计事件）。
 * @returns true = 本次真的迁了；false = 已在 pending_payment（重复发起/换通道）
 *          或状态已被迁走——**不是错误**，调用方按自己的守卫另行判定。
 * @why 守卫只认 `created`：重复发起不重复记事件（时间线里两个 pending_payment
 *      会让"到底发起了几次"变成猜谜），已在 pending_payment 的单继续走流程即可。
 */
export async function markOrderPendingPayment(
  tx: Db,
  orderId: string,
  at: Date,
  /** `user:<id>`（与建单 / 取消两处同形；曾写成不带 id 的 `'user'`，一致性审计 C3，AJ-176）。 */
  actor: string,
): Promise<boolean> {
  const updated = await tx`
    update orders set status = 'pending_payment', updated_at = now()
     where id = ${orderId} and status = 'created'
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, actor, at)
    values (${orderId}, 'pending_payment', ${actor}, ${at})
  `;
  return true;
}

/**
 * 落短链 token 的 sha256（D-49）。
 * @why **覆盖写**：同一订单重新发起支付时轮换 token——旧链接立即失效（hash 对不上），
 *      只有最新签发的链接可用。明文 token 永不落库（库里只有 hash），
 *      所以"重新发起时返回同一个链接"在设计上不可能，轮换是唯一诚实的做法。
 */
export async function setPayTokenHash(tx: Db, orderId: string, hash: string): Promise<void> {
  await tx`update orders set pay_token_hash = ${hash}, updated_at = now() where id = ${orderId}`;
}

/**
 * `GET /pay/link/{id}` 的校验素材（订单状态 + token hash + 在途支付的托管页 URL）。
 * @why 带 `expires_at`：「到点未扫」（pending_payment 但已过支付窗口、关单 job 还没扫到）
 *      的订单，链接必须当场失效——判定方向与关单扫描 / mark-paid 守卫 / pay-intent 守卫
 *      共享同一语义（`now >= expires_at` 即不可付，本文件头 @why ①），
 *      短链是第四个、也是最后一个消费这个比较方向的入口。
 */
export interface PayLinkRow {
  status: string;
  expires_at: Date;
  pay_token_hash: string | null;
  pay_url: string | null;
}

/**
 * 短链落地校验的一次性读取（LEFT JOIN 在途支付行；无 initiated 行 → pay_url null）。
 * @why 只联 **initiated**：支付行已作废（换通道/取消）意味着旧链接必须死——
 *      用 cancelled 行的 pay_url 跳转 = 把用户送去一笔我们已不认账的支付。
 */
export async function findPayLinkTarget(db: Db, orderId: string): Promise<PayLinkRow | null> {
  const rows = await db`
    select o.status, o.expires_at, o.pay_token_hash, p.pay_url
      from orders o
      left join payments p on p.order_id = o.id and p.status = 'initiated'
     where o.id = ${orderId}
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    status: String(r.status),
    expires_at: r.expires_at as Date,
    pay_token_hash: r.pay_token_hash === null ? null : String(r.pay_token_hash),
    pay_url: r.pay_url === null ? null : String(r.pay_url),
  };
}

/**
 * 建单前锁住用户行，并返回"是否已被拉黑 / 当前在途单数"（AJ-240）。
 *
 * @returns 用户不存在返回 null（token 有效而用户行没了——按无权限处理，由调用方决定码）
 *
 * @why `for update` 锁 **users 行**：在途单上限是"先数、再插"，两个并发建单各自数到 2、各自插入，
 *      就会变成 4 张。锁住用户行让同一用户的建单**串行**，第二个进来时数到的是第一个已提交的结果。
 *      跨用户互不影响（锁的是各自的行）。
 * @why 锁序 users → products：与拉黑（`block-user.ts`：users → orders → products）同向，不成环。
 *      建单此前不锁 users，所以这是**新增**的一把锁，而不是改顺序。
 * @why 顺带读 `blocked_at`：鉴权层的身份有最长 60 秒缓存，刚被拉黑的人在窗口内仍能通过守卫；
 *      拉黑会同事务取消其在途单（AJ-213），但窗口内新建的单会漏过那一轮扫描。
 *      在这把锁下读到的拉黑状态与拉黑事务是串行的：要么拉黑先提交（这里读到已拉黑），
 *      要么建单先提交（拉黑的连带取消会扫到这张单）。
 * @limitation 在途单只按 `status` 数，不看 `expires_at`：已过期但关单作业还没扫到的单仍占名额（最长约一分钟）。
 */
export async function lockUserForOrdering(
  tx: Db,
  userId: string,
): Promise<{ blocked: boolean; openOrders: number } | null> {
  const users = await tx`select blocked_at from users where id = ${userId} for update`;
  const u = users[0];
  if (u === undefined) return null;
  const rows = await tx`
    select count(*)::int as n from orders
     where user_id = ${userId} and status in ('created', 'pending_payment')
  `;
  return { blocked: u.blocked_at !== null, openOrders: Number(rows[0]?.n ?? 0) };
}
