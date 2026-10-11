/**
 * 职责：订单列表页（`pages/order`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 状态文案是**最容易两处漂移**的东西：契约有 10 态（`OrderStatus`），
 *      服务端按态流转，前端按态显示中文与"能不能继续付"。
 *      写死在 wxml 里的后果是：加一个状态要动 wxml 十处 `wx:if`，
 *      漏掉的那处表现为"这个状态的订单显示成空白"。
 *
 * @limitation 一：状态词表**与契约双向比对**（单测里从 yaml 抽 enum 校验）。
 *              缺了那条比对，服务端新增一个状态后前端会静默走 `unknown` 分支。
 * @limitation 二：`canPay` 只认 `created` / `pending_payment`——
 *              与契约 `POST /orders/{id}/cancel` 的可取消态**故意一致**：
 *              两个"这个订单还能操作吗"的判断若不一致，
 *              表现为"能付但取消不了"这种说不清的半开状态。
 *
 * @see ../../utils/price-format.js（金额与副行）；
 *      ../../../contracts/api-contract.yaml（OrderStatus / OrderSummary）
 */
import { displaySubLine, formatJpy } from '../../utils/price-format.js';
// ⚠️ 状态词表与可付态的真源在 `../../utils/order-status.js`（U-H3 下沉）：
//    订单详情页也要用，而页面不能 import 页面。与契约的双向比对测试跟着真源一起搬走
//    （只搬代码不搬测试 = 守护静默消失，见 utils/order-status.unit.test.ts）。
import { PAYABLE, buyerStatus } from '../../utils/order-status.js';
import { ORDER_TABS, resolveOrderTab } from '../../utils/order-tabs.js';
import { jstDateTimeLabeled } from '../../utils/jst-text.js';
import { PLACEHOLDER_IMAGE } from '../../utils/placeholder.js';

/**
 * 列表缩略图地址（M-11，AJ-408）：**thumb 档优先**，其次 card / detail；都没有 → 占位图。
 * @why 不复用 `imageUrl()`：它为卡片 / 详情服务，优先取 card 档；列表行的图只有 20% 宽，取 card 是白下大图。
 * @why 没图给占位图而不是空串（同详情页 itemRows）：空白方块分不清"没图"和"图没加载出来"。
 */
function thumbUrl(image) {
  const o = image !== null && typeof image === 'object' ? image : {};
  for (const src of [o.thumb, o.card, o.detail]) {
    if (typeof src === 'string' && src.trim() !== '') return src.trim();
  }
  return PLACEHOLDER_IMAGE;
}

/**
 * 有售后申请时，列表行的提示改说售后进度（三端联动模拟 2026-10-10，用 AJ-430 起列表带的 `after_sale_state`）。
 * @why 已送达 / 已完成的提示是"可进订单详情申请售后"——买家已经申请过还这么说，会让人再去申请一次（撞重复申请），
 *      或以为上次没提交成功。
 * @why 只改发货后三态：退款中 / 已退款的提示讲的是钱，比售后进度更要紧，不让售后盖掉它。
 * @limitation `closed` 不分"已处理 / 未通过"——列表接口只给开着 / 结了两档，具体结果在详情页售后卡片里。
 */
const AFTER_SALE_LIST_HINTS = {
  open: '售后申请处理中，结果会在订单详情回复。',
  closed: '售后已有处理结果，可进订单详情查看。',
};
const AFTER_SALE_HINT_STATUSES = ['shipped', 'delivered', 'completed'];

/**
 * 待付款行写明付款截止时刻（AJ-435，契约 0.6.61 列表行 `expires_at`）。
 * @why 原先只说"请在截止时间前完成支付"，却不说截止是几点；时刻用详情页同一个 `jstDateTimeLabeled`（带"（日本时间）"），
 *      两处说法一致。用绝对时刻而不是"还剩 N 分钟"：列表不跑秒表，相对时间停留几分钟就过时了。
 * @limitation 截止时刻缺失或解析不了 → 回落到不带时刻的原句（不编时间）。
 */
const DEADLINE_HINTS = {
  created: (at) => `请在 ${at}前完成支付，超时订单会自动关闭。`,
  pending_payment: (at) =>
    `如果已经完成付款，系统确认后这里会更新；还没付的话，请在 ${at}前继续支付。`,
};

/** 截止已到、还没关单时的下一步（与订单详情 vm 同一句）。 */
const EXPIRED_NEXT = '支付时间已到，订单将自动关闭；如需购买请重新下单';

/** 一行的"下一步"提示：售后进度 > 付款截止 > 订单状态的列表提示。 */
function nextTextOf(o, status, buyer) {
  if (
    AFTER_SALE_HINT_STATUSES.includes(status) &&
    (o.after_sale_state === 'open' || o.after_sale_state === 'closed')
  ) {
    return AFTER_SALE_LIST_HINTS[o.after_sale_state];
  }
  const deadline = Object.prototype.hasOwnProperty.call(DEADLINE_HINTS, status)
    ? jstDateTimeLabeled(o.expires_at)
    : null;
  return typeof deadline === 'string' && deadline !== ''
    ? DEADLINE_HINTS[status](deadline)
    : buyer.next;
}

/**
 * `GET /orders` 的 items → 列表行。
 * @param {unknown} items 契约 `OrderSummary[]`
 * @param {number} [nowMs] 当前时刻（判付款截止，MP-14）；不传 = 不判（时间由入参给，vm 不读时钟）
 * @returns {Array<{orderId: string, orderNo: string, totalJpy: number|null, totalText: string,
 *                  totalSub: string, statusText: string, nextText: string, canPay: boolean,
 *                  createdText: string, thumb: string, itemCountText: string, titleText: string}>}
 * @why M-11（AJ-408）：行里补下单时间（找单靠它）、首件缩略图与件数（契约 0.6.49 `OrderListItem`）。
 *      时间走 `jstDateTimeLabeled`（纯整数换算，不读时钟；带"（日本时间）"，同详情页 MP3-02 口径），
 *      解析不了给空串——列表行不回落原串（详情页才是"数据不能丢"的地方，列表行宁缺不错）。
 * @why M-06（AJ-405）：状态用买家视角词表 `buyerStatus`（"已付款 · 日本采购中"）并带一句"下一步"；
 *      列表行（OrderSummary）不含 contact_email，所以不传 email——不承诺"会发邮件"。
 * @why 同时给 `totalJpy`（整数，交给 `ws-price`）与 `totalText`（已格式化串）：
 *      `ws-price` 只收整数（对非整数**响亮失败**：空白 + 控制台报错），
 *      而"没有合计"的订单连组件都不该渲染——所以整数是 null 而不是 0
 *      （`0 円` 会被读成"这单不要钱"）。
 */
export function orderRows(items, nowMs = undefined) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((o) => o && typeof o.order_id === 'string' && o.order_id !== '')
    .map((o) => {
      const status = typeof o.status === 'string' ? o.status : '';
      const hasTotal = Number.isInteger(o.total_jpy);
      const buyer = buyerStatus(status, { inList: true });
      // MP-14（第二轮审计 2026-10-11）：截止已到但关单作业还没跑（最多约 1 分钟）——与详情页同口径，不再给「继续支付」
      const expiresMs = typeof o.expires_at === 'string' ? Date.parse(o.expires_at) : Number.NaN;
      const expired =
        PAYABLE.includes(status) &&
        Number.isFinite(nowMs) &&
        Number.isFinite(expiresMs) &&
        nowMs >= expiresMs;
      return {
        orderId: o.order_id,
        orderNo: typeof o.order_no === 'string' ? o.order_no : '',
        totalJpy: hasTotal ? o.total_jpy : null,
        totalText: hasTotal ? formatJpy(o.total_jpy) : '',
        totalSub: displaySubLine(o.display),
        // ⚠️ 不在词表里的状态给 '状态未知' 而不是空串：
        //    空串在真机上就是一个空白的标签，用户无法区分"没状态"和"渲染错了"
        statusText: buyer.title,
        nextText: expired ? EXPIRED_NEXT : nextTextOf(o, status, buyer),
        canPay: PAYABLE.includes(status) && !expired,
        createdText: jstDateTimeLabeled(o.created_at) ?? '',
        thumb: thumbUrl(o.first_image),
        itemCountText:
          Number.isInteger(o.item_count) && o.item_count > 0 ? `共 ${o.item_count} 件` : '',
        // A8（AJ-416，契约 0.6.54）：首件商品名（下单快照）——只看缩略图分不清两张都是饼干的单
        titleText: typeof o.first_title === 'string' ? o.first_title : '',
      };
    });
}

/**
 * 空态（开关 + 文案）。
 * @param {unknown} rows `orderRows` 的输出
 * @param {unknown} error 错误文案（空串 = 无错误）
 * @param {unknown} [tabKey] 当前页签（M-10）；缺省 = 「全部」
 * @why 与地址列表同一条口径：请求失败时**不能**说"还没有订单"
 *      （用户会以为订单丢了，那是最坏的暗示）。
 * @why 分页签的空态不说"还没有订单"（M-10）：「待付款」里空着不等于一单都没有。
 */
export function emptyState(rows, error, tabKey = undefined) {
  const showEmpty = Array.isArray(rows) && rows.length === 0 && error === '';
  const key = resolveOrderTab(tabKey);
  const tab = ORDER_TABS.find((t) => t.key === key);
  const text = key === 'all' || tab === undefined ? '还没有订单' : `「${tab.label}」里暂时没有订单`;
  return { showEmpty, text };
}

/**
 * 页签条视图（M-10，AJ-408）。
 * @param {unknown} activeKey 当前页签；认不出 → 「全部」
 * @returns {Array<{key: string, label: string, active: boolean}>}
 * @limitation 页签上**不带计数**：列表接口无分页也无 total，要计数得为每个页签各拉一次全量；
 *              计数只在「我的」四入口上给（一次全量请求本地分组，见 pages/user/index.vm.js orderShortcuts）。
 */
export function tabsView(activeKey) {
  const key = resolveOrderTab(activeKey);
  return ORDER_TABS.map((t) => ({ key: t.key, label: t.label, active: t.key === key }));
}
