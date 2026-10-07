/**
 * 职责：管理端**工作台销售统计**的仓储（AJ-393；管理后台对标分析第一批③ / §8-2）。
 *
 * @why 单独一个文件而不是塞进 `orders-admin.ts`：那里的每条查询都是"一张单的读与写"
 *      （列表 / 详情 / 发货 / 退款），而这里是**跨单聚合**。混在一起会让
 *      "这条 SQL 带不带 user_id 过滤"这个该文件最重要的性质（@why：管理端 SQL 没有它）
 *      变得要看具体函数才能判断——聚合查询天然跨用户，两种性质必须分开摆放才看得清。
 *
 * ── 口径（**唯一出处**；改这里的任何一条都要同步契约描述与管理端文案）───────────────
 *
 * | 指标 | 口径 | 为什么是这条 |
 * |---|---|---|
 * | 窗口 | **左闭右开**，两端取 JST 日界（`jstDayWindow`）；右端恒为"明日 00:00" | 右端取"此刻"的话同一天每次刷新数字都在变，且"今日"与"近 7 天"两个窗口的右端会不一致——那样两者无法互相校验 |
 * | 测试单 | **一律排除**（`is_test = false`） | 工作台是经营数据。审核期造的测试单混进"今日销售额"，运营会拿着一个虚高的数字做判断，而它看起来完全合理 |
 * | `orders` | `created_at` 落窗 | "今天来了几张单" |
 * | `paid_orders` / `sales_jpy` | `paid_at` 落窗，`total_jpy` 求和 | "今天卖了多少钱"按**收款**时刻，不按下单时刻（跨日的单不该算在昨天） |
 * | `received` | `payments` 的**实扣**金额（`paid_amount` / `paid_currency`，缺失回落 `charge_*`），按扣款币种**分行、不折算** | §8-2：实收要和支付机构对账，折算后对不上。分行而不是求和，是因为 USD 分与円不能直接相加 |
 * | `refunded` | ① 全额退款单：`payments` 被标 `refunded` 那条的 `charge_amount`；② 部分退款：`status='succeeded'` 的行，且**该订单当前不是 `refunded`** | 全额退款**不写** `order_refunds`（只改状态机，见 orders-admin.ts `markRefunded`），只取一个来源必然漏一半；而"先部分退 X 再全额退"时全额那笔实际退的是 `charge - X`（`fullRefundAmount`），两条相加正好等于 `charge`，所以必须排除被全额覆盖的那部分，否则 X 被算两遍 |
 * | `disputed` | `payments.dispute_amount`（**机构报的数**，非订单金额），按 `dispute_opened_at` 落窗 | 对账以机构口径为准（mark-disputed.ts @why）；机构报的币种与 `charge_currency` 不一致时那条会被直接拒绝，所以币种取 `charge_currency` 是安全的 |
 *
 * @limitation 一：**全表扫**。`orders` 上只有 `(user_id, created_at)`、`(status)` 与 032 加的
 *              管理端列表索引，没有 `paid_at` / `refunded_at` 的索引。MVP 单量（百级）下无感；
 *              到万级要先加表达式索引，否则工作台每开一次就扫一遍全表。
 *              ⚠️ 这里刻意**不**加"只扫最近 N 天"的额外 WHERE：窗口由调用方给，
 *              仓储不该再猜一次"调用方大概要多久"。
 * @limitation 二：币种行的顺序是 `currency` 升序（SQL `order by`），**不是**金额降序。
 *              排序稳定是让用例能断言"第一行是 USD"；要按金额排是展示层的事。
 * @limitation 三：`received` 把 `refunded` 状态的支付行也算作"收过"——钱确实进过账，
 *              退没退由 `refunded` 那一行单独说。两者不是同一件事，不该互相抵消。
 *
 * @see migrations/001_init.sql（orders / payments）；030_order_refunds.sql；
 *      domain/partial-refund.ts（`fullRefundAmount`）；app/admin-dashboard-routes.ts（唯一调用方）
 */
import type { Db } from './db.js';
import type { JstDayWindow } from '@waselect/shared';

/** 按币种分行的一笔钱（`amount` 恒为该币种**最小单位**）。 */
export interface MoneyByCurrency {
  currency: string;
  amount: number;
}

/** 一个窗口内的销售统计（金额一律整数最小单位；`salesJpy` 是円）。 */
export interface SalesWindowStats {
  /** 窗口内创建的订单数（不含测试单）。 */
  orders: number;
  /** 窗口内**收款**的订单数（`paid_at` 落窗）。 */
  paidOrders: number;
  /** 窗口内收款订单的 `total_jpy` 合计。 */
  salesJpy: number;
  /** 实收，按扣款币种分行（不折算）。 */
  received: readonly MoneyByCurrency[];
  /** 已退，按币种分行（不折算）。 */
  refunded: readonly MoneyByCurrency[];
  /** 拒付金额（机构口径），按币种分行。 */
  disputed: readonly MoneyByCurrency[];
}

/**
 * 币种聚合行 → `MoneyByCurrency`。
 *
 * @why `String(...).trim()`：`charge_currency` / `currency` 都是 `CHAR(3)`，
 *      驱动可能按定长返回尾部空格（现存的三个币种恰好都是 3 字符，但换币种那天才会发现）。
 *      与 `ops-config.ts` 的 `toFxRateRow` 同手法——**修一次，抄两次**不如一开始就走同一个动作。
 * @why 金额走 `Number(...)`：`sum()` 的返回在 int8 上是 string（postgres.js 的行为），
 *      在 int4 上是 number；显式转换让两种驱动行为都不至于把一个字符串送进 JSON。
 */
function toMoney(r: Record<string, unknown>): MoneyByCurrency {
  return {
    currency: String(r['currency']).trim(),
    amount: Number(r['amount'] ?? 0),
  };
}

function toMoneyList(rows: readonly Record<string, unknown>[]): MoneyByCurrency[] {
  return rows.map(toMoney);
}

/** 订单数 / 收款单数 / 销售额（円）。三条同一个窗口口径，一次查询拿全（少两趟往返）。 */
async function selectOrderTotals(
  db: Db,
  w: JstDayWindow,
): Promise<Pick<SalesWindowStats, 'orders' | 'paidOrders' | 'salesJpy'>> {
  const [r] = await db`
    select
      count(*) filter (where created_at >= ${w.from} and created_at < ${w.to})::int        as orders,
      count(*) filter (where paid_at   >= ${w.from} and paid_at   < ${w.to})::int          as paid_orders,
      coalesce(sum(total_jpy) filter (where paid_at >= ${w.from} and paid_at < ${w.to}), 0)::bigint
                                                                                          as sales_jpy
      from orders
     where is_test = false
  `;
  return {
    orders: Number(r?.['orders'] ?? 0),
    paidOrders: Number(r?.['paid_orders'] ?? 0),
    salesJpy: Number(r?.['sales_jpy'] ?? 0),
  };
}

/**
 * 实收：按扣款币种分行。
 *
 * @why 只取 `succeeded` / `refunded` 两态：`initiated` 是"登记了还没扣"，
 *      `failed` / `cancelled` 是没扣成——它们都不是钱。
 * @why 金额优先 `paid_amount`（机构实际扣到的，可能与登记数差几分），缺失才回落 `charge_amount`：
 *      与契约 `Order.payment.paid_amount` 同口径（`app/order-views.ts` 的 `toPaymentView`）。
 */
async function selectReceived(db: Db, w: JstDayWindow): Promise<MoneyByCurrency[]> {
  const rows = await db`
    select coalesce(p.paid_currency, p.charge_currency) as currency,
           sum(coalesce(p.paid_amount, p.charge_amount))::bigint as amount
      from payments p
      join orders o on o.id = p.order_id
     where o.is_test = false
       and p.status in ('succeeded', 'refunded')
       and o.paid_at >= ${w.from} and o.paid_at < ${w.to}
     group by 1
     order by 1
  `;
  return toMoneyList(rows as readonly Record<string, unknown>[]);
}

/**
 * 已退：两个来源相加（@see 文件头口径表）。
 *
 * @why 用一个 `union all` 而不是两次查询后在 JS 里合并：合并逻辑（按币种累加）
 *      写在 JS 里就是第二份"钱怎么加"的实现，而这份实现没有 SQL 的 `sum` 兜底，
 *      漏一个币种行的表现是"少一行"而不是"报错"。
 * @why 部分退款的时间口径是**落定**时刻（`coalesce(settled_at, created_at)`）：
 *      "今天退了多少"应指钱今天真的出去了；`succeeded` 必有 `settled_at`，
 *      `coalesce` 只是为了让"脏数据缺列"不至于把整笔从窗口里抹掉（那会静默少钱）。
 */
async function selectRefunded(db: Db, w: JstDayWindow): Promise<MoneyByCurrency[]> {
  const rows = await db`
    with full_refunds as (
      select p.charge_currency as currency, p.charge_amount as amount
        from payments p
        join orders o on o.id = p.order_id
       where o.is_test = false
         and o.status = 'refunded'
         and p.status = 'refunded'
         and o.refunded_at >= ${w.from} and o.refunded_at < ${w.to}
    ), partial as (
      select r.currency, r.amount_minor as amount
        from order_refunds r
        join orders o on o.id = r.order_id
       where o.is_test = false
         and r.status = 'succeeded'
         and o.status <> 'refunded'
         and coalesce(r.settled_at, r.created_at) >= ${w.from}
         and coalesce(r.settled_at, r.created_at) <  ${w.to}
    )
    select currency, sum(amount)::bigint as amount
      from (select currency, amount from full_refunds
            union all
            select currency, amount from partial) t
     group by currency
     order by currency
  `;
  return toMoneyList(rows as readonly Record<string, unknown>[]);
}

/**
 * 拒付金额（机构口径），按 `dispute_opened_at` 落窗。
 *
 * @why 用**开案**时间而不是"订单付款时间"：拒付是今天发生的一件事，
 *      而它可能针对上个月的单；按下单时间归窗会让"今天有拒付"在卡片上永远不出现。
 */
async function selectDisputed(db: Db, w: JstDayWindow): Promise<MoneyByCurrency[]> {
  const rows = await db`
    select p.charge_currency as currency,
           sum(p.dispute_amount)::bigint as amount
      from payments p
      join orders o on o.id = p.order_id
     where o.is_test = false
       and p.dispute_amount is not null
       and p.dispute_opened_at >= ${w.from} and p.dispute_opened_at < ${w.to}
     group by p.charge_currency
     order by p.charge_currency
  `;
  return toMoneyList(rows as readonly Record<string, unknown>[]);
}

/** 一个窗口的完整统计（四次查询；工作台一次加载两窗口，共八趟——单页低频，可接受）。 */
export async function loadSalesWindow(db: Db, w: JstDayWindow): Promise<SalesWindowStats> {
  const [totals, received, refunded, disputed] = await Promise.all([
    selectOrderTotals(db, w),
    selectReceived(db, w),
    selectRefunded(db, w),
    selectDisputed(db, w),
  ]);
  return { ...totals, received, refunded, disputed };
}
