/**
 * 职责：订单详情**进度条**（M-12，AJ-408）——状态（+ 时间线）→ 五步进度 + 终态分支。纯函数。
 *
 * @why 五步「下单 → 付款 → 日本采购 → 发货 → 送达」对应代购的真实阶段（对标分析 §3.7 骨架图）；
 *      "采购"单列一步是代购与现货电商的差别：付款到发货之间有几天空档（M-06 要消除的"是不是卡住了"）。
 * @why 主线按**当前状态**点亮（不靠时间线）：状态是权威，时间线可能缺行（老数据 / 读失败）。
 *      `created` / `pending_payment` 的当前步是"付款"——单已下好，正在等付款。
 * @why 终态（取消 / 超时 / 退款中 / 已退款）画成"主线点亮到发生前那一步 + 分支标签"，而不是把主线全灰：
 *      买家要知道的是"退款前货发没发"——发货后退款与采购前退款，后续动作完全不同（要不要等包裹）。
 *      点亮到哪一步**看时间线**里出现过的主线状态；没有时间线时按状态机保守推断
 *      （server/src/domain/order.ts ORDER_TRANSITIONS：cancelled / expired 只能从待付款进入 → 只亮"下单"；
 *       refunding 只能从 paid / shipped / delivered 进入 → 至少亮到"付款"，不猜发没发货）。
 * @why 分支标题用 `BUYER_STATUS` 的买家视角 title（同一张词表，M-06），不另写一套。
 * @tradeoff **不在进度条上显示时刻**：五格宽度放不下"（日本时间）"标注，而不标时区的时刻会被美国买家
 *           读成本地时间（MP3-02 / AJ-250）；完整时刻在下方时间线里（带标注）。代价是进度条本身看不出"哪天"。
 * @limitation 未知状态 → `show: false`（不显示进度条）：给一个可能说错话的进度，比不给更糟；状态区仍会写"状态未知"。
 * @see ./order-status.js（BUYER_STATUS）；../pages/order-detail/index.vm.js（消费方）
 */
import { BUYER_STATUS } from './order-status.js';

/** 五步（顺序即展示顺序）。 */
export const PROGRESS_STEPS = [
  { key: 'placed', label: '下单' },
  { key: 'paid', label: '付款' },
  { key: 'purchasing', label: '日本采购' },
  { key: 'shipped', label: '发货' },
  { key: 'delivered', label: '送达' },
];

/**
 * 主线状态 → 当前步下标（= 已完成的步数；5 = 全部完成）。
 * @why "当前步"是**正在进行的那一步**：待付款 → 付款、已付款 → 日本采购、已发货 → 送达（国际运输中）、
 *      已送达 / 已完成 → 全部完成。三端联动模拟（2026-10-10）前 shipped / delivered 各少算一格——
 *      标题写"已送达"，送达那一步却是空心；且与下方 REACHED_BY_EVENT（分支按时间线点亮）不是同一把尺子。
 *      两张表的一致性由单测「主线与分支同一把尺子」钉住。
 */
const MAINLINE_CURRENT = {
  created: 1,
  pending_payment: 1,
  paid: 2,
  shipped: 4,
  delivered: 5,
  completed: 5,
};

/** 时间线里出现过的主线状态 → 至少已完成几步。 */
const REACHED_BY_EVENT = { paid: 2, shipped: 4, delivered: 5, completed: 5 };

/** 终态分支 → 没有时间线时保守认定的已完成步数（@see 文件头 @why 状态机推断）。 */
const BRANCH_FLOOR = { cancelled: 1, expired: 1, refunding: 2, refunded: 2 };

/**
 * @param {unknown} order 契约 `Order`（读 `status` 与 `timeline`）
 * @returns {{show: boolean, steps: Array<{key: string, label: string, state: 'done'|'current'|'todo'|'skipped'}>,
 *            branch: {status: string, title: string}|null}}
 */
export function orderProgress(order) {
  const o = order !== null && typeof order === 'object' ? order : {};
  const status = typeof o.status === 'string' ? o.status : '';
  const own = (table) => Object.prototype.hasOwnProperty.call(table, status);

  if (own(MAINLINE_CURRENT)) {
    const cur = MAINLINE_CURRENT[status];
    const steps = PROGRESS_STEPS.map((s, i) => ({
      ...s,
      state: i < cur ? 'done' : i === cur ? 'current' : 'todo',
    }));
    return { show: true, steps, branch: null };
  }

  if (own(BRANCH_FLOOR)) {
    let reached = BRANCH_FLOOR[status];
    for (const t of Array.isArray(o.timeline) ? o.timeline : []) {
      const s = t !== null && typeof t === 'object' ? t.status : undefined;
      if (typeof s === 'string' && Object.prototype.hasOwnProperty.call(REACHED_BY_EVENT, s)) {
        reached = Math.max(reached, REACHED_BY_EVENT[s]);
      }
    }
    const steps = PROGRESS_STEPS.map((s, i) => ({ ...s, state: i < reached ? 'done' : 'skipped' }));
    return { show: true, steps, branch: { status, title: BUYER_STATUS[status].title } };
  }

  return { show: false, steps: [], branch: null };
}
