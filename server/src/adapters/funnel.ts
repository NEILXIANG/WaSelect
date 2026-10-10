/**
 * 职责：转化漏斗的**唯一口径**（第 25 项，AJ-438，契约 0.6.62）——窗口内六步各有多少"人"。
 *
 * 六步：进店（任一页面）→ 看商品详情 → 有购买意向（加购 或 进结算）→ 进结算 → 发起支付 → 付款成功。
 *
 * @why 按"人"而不是按事件或按设备数：有 user_id 用 user_id；没有的（登录完成前那几条）借**同一设备 session
 *      在窗口内登录过的 user_id**；都没有才算一个匿名设备（`anon:` 前缀，与 user_id 不会撞）。
 *      @measured 2026-10-10 sim 库：user_events 里 5 个 session、13 个 user_id（模拟时同一模拟器切换多个买家）——
 *      只按 session 会把多个人并成一个，只按 user_id 会漏掉未登录的浏览。
 * @why 逐步**嵌套**（每一步只数上一步也到过的人）：漏斗的意义是"到这一步还剩多少人"；不嵌套时后一步可能比前一步大
 *      （如分享链接直达详情的人没看过首页），比例就失去意义。第 1 步取"任一页面"而不是"首页"，正是为了不把分享链接进来的人整个排除。
 * @why "有购买意向"= 加购 或 进结算：立即购买不经过购物车、不发 add_to_cart（pages/detail onBuyNow），只算加购会漏掉这批人。
 * @why "付款成功"以订单表为准（pay_start 带的 order_id → orders.paid_at 非空且非测试单），不看前端事件——前端不知道钱到没到。
 * @limitation 一：只按窗口内"到没到过"，**不看先后顺序**（先加购后看详情也算）；对日百单量级足够，要严格时序需按会话排序重写。
 * @limitation 二：同一设备窗口内登录过多个账号时，匿名事件借其中一个（max）；真机上一台手机一个微信号，基本不会发生。
 * @limitation 四：前五步不区分测试账号，第 6 步排除测试单——内部测试走完全程会压低 5→6 步比例（行为事件里没有"测试"标记可用）。
 * @limitation 三：sess_user 子查询按 created_at 扫窗口内全部事件（只有 (event, created_at) 与 (user_id, created_at) 索引）；
 *              日百单量级 30 天窗口是几万行，量大了再加 (created_at) 索引。
 * @see ../app/admin-dashboard-routes.ts（路由）；packages/shared/src/enums.ts BEACON_EVENT（事件名白名单）
 */
import type { BeaconEvent, JstDayWindow } from '@waselect/shared';
import type { Db } from './db.js';

/** 漏斗用到的事件名（satisfies：拼错 / 白名单改名时编译期就红）。 */
const EV = {
  view: 'page_view',
  addToCart: 'add_to_cart',
  checkout: 'checkout_enter',
  payStart: 'pay_start',
} as const satisfies Record<string, BeaconEvent>;

/** 六步的键（顺序即展示顺序；中文标签归前端）。 */
export const FUNNEL_STEPS = [
  'visit',
  'view_item',
  'intent',
  'checkout',
  'pay_start',
  'paid',
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export async function loadFunnel(db: Db, w: JstDayWindow): Promise<Record<FunnelStep, number>> {
  const [r] = await db`
    with sess_user as (
      select session_id, max(user_id) as user_id from user_events
       where created_at >= ${w.from} and created_at < ${w.to}
         and user_id is not null and session_id is not null
       group by session_id
    ),
    ev as (
      select coalesce(e.user_id, su.user_id, 'anon:' || e.session_id) as who, e.event, e.props
        from user_events e left join sess_user su on su.session_id = e.session_id
       where e.created_at >= ${w.from} and e.created_at < ${w.to}
         and coalesce(e.user_id, e.session_id) is not null
    ),
    s1 as (select distinct who from ev where event = ${EV.view}),
    s2 as (select distinct who from ev
            where event = ${EV.view} and props->>'page' = 'detail' and who in (select who from s1)),
    s3 as (select distinct who from ev
            where event in (${EV.addToCart}, ${EV.checkout}) and who in (select who from s2)),
    s4 as (select distinct who from ev where event = ${EV.checkout} and who in (select who from s3)),
    s5 as (select distinct who from ev where event = ${EV.payStart} and who in (select who from s4)),
    s6 as (select distinct ev.who from ev join orders o on o.id = ev.props->>'order_id'
            where ev.event = ${EV.payStart} and o.paid_at is not null and o.is_test = false
              and ev.who in (select who from s5))
    select (select count(*) from s1)::int as visit, (select count(*) from s2)::int as view_item,
           (select count(*) from s3)::int as intent, (select count(*) from s4)::int as checkout,
           (select count(*) from s5)::int as pay_start, (select count(*) from s6)::int as paid
  `;
  const out = {} as Record<FunnelStep, number>;
  for (const k of FUNNEL_STEPS) out[k] = Number(r?.[k] ?? 0);
  return out;
}
