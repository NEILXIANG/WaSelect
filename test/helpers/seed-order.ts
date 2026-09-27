/**
 * 职责：测试的「直接插库造单」helper（U6c 骨架端点退役的替代品）。
 *
 * @why 骨架端点退役后，"焦点不在建单本身"的测试（回调管线 / 通道上下线 / 装配链路）
 *      需要一个最小成本的造单手段：直接插库。形状与骨架期造的单**逐项一致**
 *      （1,000 円 / 500g / 30 分钟支付窗）——只换来源不换事实，
 *      否则"换造单方式"会顺带改掉被测前提，用例绿了也不再是原来那条。
 *
 * @why 集中成一个 helper 而不是每个测试各写一段 INSERT：列清单是 schema 耦合点，
 *      散在 N 处的 INSERT 在加列那天会各自静默缺列（NOT NULL 加列时全部变红才发现）。
 *
 * @limitation 只造 `created` 状态的单。需要 `pending_payment` 的用例（宽限期 / 租约场景）
 *             见 pay-callback-pipeline.e2e 的 seedPendingOrder——两种出生状态服务不同的
 *             测试焦点，刻意不合并成一个参数化函数（参数一多，"造了张什么单"就要逐处读）。
 */
import type { Db } from '../../server/src/adapters/db.js';

/** 造单金额：**1,000 円**（与骨架期同一口径）。payments 行的登记金额必须用它（三审 U1）。 */
export const SEED_ORDER_CHARGE = { currency: 'JPY', amountMinor: 1000 } as const;

/**
 * 插库造一张"已创建"的单（`created` + created 事件行），返回 orderId。
 * expires_at 给 30 分钟：mark-paid 的「到点未付」守卫与它同向，不能造一张"出生即迟到"的单。
 */
export async function seedCreatedOrder(
  db: Db,
  orderId: string,
  opts: { userId: string },
): Promise<string> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
    values (${orderId}, ${`W-${orderId}`}, ${opts.userId}, 'created',
            ${SEED_ORDER_CHARGE.amountMinor}, 0, 0, ${SEED_ORDER_CHARGE.amountMinor}, 500,
            '{}'::jsonb, '{}'::jsonb, 'E2E-SEED', now() + interval '30 minutes')
  `;
  // created 事件行必须补：否则"事件序列 ['created','paid']"的断言就弱化成"只数到一条就算对"
  await db`
    insert into order_events (order_id, status, actor)
    values (${orderId}, 'created', ${`user:${opts.userId}`})
  `;
  return orderId;
}
