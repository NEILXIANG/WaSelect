/**
 * 职责：订单详情页（`pages/order-detail`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 订单列表只能回答"付没付、多少钱"，详情页要回答的是**"这单到底走到哪了"**——
 *      时间线、运单号、收货地址快照、建单时同意的条款版本。
 *      这些字段里有三个**错了不报错**的：
 *      ① 时间线时刻（UTC 存、JST 显）——错 9 小时没有任何异常；
 *      ② 关税行——`duty_jpy` 是**信息字段**（商品价已含关税），
 *         把它当成"另收一行"会让用户以为被收了两次；
 *      ③ 取消按钮——出现态与契约 `POST /orders/{id}/cancel` 的合法态
 *         （仅 created / pending_payment）不一致时，点了就是一个 40902，
 *         而用户读不懂那是什么。
 *
 * @why 状态词表 / 可付态**不在本文件**：真源在 `utils/order-status.js`（U-H3 下沉），
 *      页面不能 import 页面；两处各写一份的后果是"详情页说能取消、列表页没这按钮"。
 * @why 时间转换也不在 wxml / 页面 js：JST 换算是纯整数运算（`utils/jst-text.js`），
 *      它的跨年 / 跨月 / 闰日边界全有单测——放进页面 js 就一行测试都没有。
 *
 * @limitation 一：**不做 30 分钟倒计时**。倒计时要 `setInterval`（又一个要登记的宿主能力）
 *              + 时钟读数（vm 禁读），骨架期只显示 `expires_at` 的**时刻**；
 *              到期后订单列表会显示"已超时关闭"（服务端过期 job 是权威）。
 * @limitation 二：关税行在 `duty_jpy` 为整数时显示"预估关税（含在商品价内）"——
 *              契约 Order 里它是建单时记下的估值，**信息字段**（D-32 商品价已含关税），
 *              不许显示成"关税：另收"。
 * @limitation 三：`terms_version` 原样展示（如 `TOS-2026-09-20`）。
 *              它是"你当时同意的是哪一版"的唯一凭证，比"已同意"三个字值钱；
 *              链接去法务页（`pages/legal`），不在本页重复入口。
 *
 * @see ../../utils/order-status.js（状态词表与可付/可取消态真源）；
 *      ../../utils/jst-text.js（UTC → JST 纯函数）；
 *      ../../../contracts/api-contract.yaml（Order / POST /orders/{id}/cancel）
 */
import { PAYABLE, canPay, statusText } from '../../utils/order-status.js';
import { displaySubLine, formatJpy } from '../../utils/price-format.js';
import { PLACEHOLDER_IMAGE, imageUrl } from '../../utils/placeholder.js';
import { addressSummary } from '../../utils/address-form.js';
import { jstDateTime } from '../../utils/jst-text.js';

/** ISO → JST 展示串；解析失败回落原串（数据不能丢，宁可难看）。 */
function timeText(iso) {
  return jstDateTime(iso) ?? (typeof iso === 'string' ? iso : '');
}

/**
 * 行项目（**含单价**：详情页是"这单当时买了什么"的凭据，与结算页"行里不带价格"相反——
 * 那里的价格会过期，这里的是快照，恰恰是它存在的意义）。
 */
export function itemRows(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => i && typeof i.product_id === 'string' && i.product_id !== '')
    .map((i) => {
      const hasPrice = Number.isInteger(i.unit_price_jpy);
      const url = imageUrl(i.image);
      return {
        productId: i.product_id,
        title: typeof i.title === 'string' ? i.title : '',
        qty: Number.isInteger(i.qty) ? i.qty : 1,
        unitPriceJpy: hasPrice ? i.unit_price_jpy : null,
        unitPriceText: hasPrice ? formatJpy(i.unit_price_jpy) : '',
        image: url !== '' ? url : PLACEHOLDER_IMAGE,
      };
    });
}

/**
 * 金额行（**不含合计**：合计交给 `ws-price`，@see quote-view.js 同一理由）。
 * @param {unknown} order 契约 `Order`
 */
export function amountLines(order) {
  const o = order && typeof order === 'object' ? order : {};
  const lines = [];
  if (Number.isInteger(o.items_jpy))
    lines.push({ label: '商品合计', value: formatJpy(o.items_jpy) });
  if (Number.isInteger(o.shipping_jpy))
    lines.push({ label: '运费', value: formatJpy(o.shipping_jpy) });
  // @see @limitation 二：关税是信息字段（含在商品价内），不是另收的一行
  if (Number.isInteger(o.duty_jpy)) {
    lines.push({ label: '预估关税（含在商品价内）', value: formatJpy(o.duty_jpy) });
  }
  return lines;
}

/** 时间线行：状态中文 + JST 时刻。 */
export function timelineRows(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter((t) => t && typeof t.status === 'string' && t.status !== '')
    .map((t) => ({ statusText: statusText(t.status), atText: timeText(t.at) }));
}

/**
 * `GET /orders/{id}` → 详情页视图。
 * @param {unknown} order 契约 `Order`；也可能是任何东西
 * @returns 见各字段注释
 */
export function detailView(order) {
  const o = order && typeof order === 'object' ? order : {};
  const status = typeof o.status === 'string' ? o.status : '';
  const payable = canPay(status);
  const hasTotal = Number.isInteger(o.total_jpy);
  const trackingNo = typeof o.tracking_no === 'string' ? o.tracking_no.trim() : '';

  return {
    orderId: typeof o.order_id === 'string' ? o.order_id : '',
    orderNo: typeof o.order_no === 'string' ? o.order_no : '',
    statusText: statusText(status),
    canPay: payable,
    /**
     * 可取消态与可付态**故意同源**（PAYABLE，@see utils/order-status.js @limitation 二）：
     * 两边各写一份的话，"能付但取消不了"这种半开状态没有任何测试能抓住。
     */
    canCancel: PAYABLE.includes(status),
    createdAtText: timeText(o.created_at),
    // ⚠️ 截止时刻只在可付时显示（@see @limitation 一：骨架期不做倒计时）
    expiresAtText: payable ? timeText(o.expires_at) : '',
    items: itemRows(o.items),
    amountLines: amountLines(o),
    totalJpy: hasTotal ? o.total_jpy : null,
    totalSub: displaySubLine(o.display),
    address: o.address !== null && typeof o.address === 'object' ? addressSummary(o.address) : null,
    contactEmail: typeof o.contact_email === 'string' ? o.contact_email : '',
    termsVersion: typeof o.terms_version === 'string' ? o.terms_version : '',
    carrier: typeof o.carrier === 'string' ? o.carrier : '',
    trackingNo,
    hasTracking: trackingNo !== '',
    timeline: timelineRows(o.timeline),
  };
}
