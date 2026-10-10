/**
 * 职责：订单通知邮件的文案表（剩余清单 2-2）——纯数据 + 纯函数，不碰 IO。
 *
 * @why 文案与发送分开（约束五"文案走配置"的服务端版）：改措辞只改这张表，订阅者与适配器不动。
 * @why 英文：收件人是美国买家（D-41 邮件兜底面向 contact_email），小程序内文案另有一套。
 * @limitation 不含金额：退款按原币原额退，邮件里写一个"折算后金额"反而容易与银行流水对不上；
 *             需要看金额的买家进订单详情。
 * @limitation 查件链接由剩余清单 3-5 补；在那之前只给承运商与运单号。
 */

/** 生成一封信所需的订单字段（订阅者从 orders 表取）。 */
export interface MailOrderFacts {
  orderNo: string;
  carrier: string | null;
  trackingNo: string | null;
}

export interface MailContent {
  subject: string;
  text: string;
}

const SIGN_OFF =
  '\n\nThank you for shopping with Waselect.\nThis is an automated message; please contact us via the mini program if you need help.';

export const MAIL_TEMPLATES: Readonly<Record<string, (o: MailOrderFacts) => MailContent>> = {
  'order.paid': (o) => ({
    subject: `Order ${o.orderNo} confirmed`,
    text: `We have received your payment for order ${o.orderNo}. We will purchase your items in Japan and ship them to you soon.${SIGN_OFF}`,
  }),
  'order.shipped': (o) => ({
    subject: `Order ${o.orderNo} has shipped`,
    text:
      `Your order ${o.orderNo} has shipped.\n` +
      `Carrier: ${o.carrier ?? '-'}\nTracking number: ${o.trackingNo ?? '-'}${SIGN_OFF}`,
  }),
  // AJ-440：撤销发货（点错 / 录错单）。不复述原运单号：库里已清空，且那个号可能属于别人的包裹
  'order.shipment_reverted': (o) => ({
    subject: `Correction: order ${o.orderNo} has not shipped yet`,
    text: `We sent you a shipping notice for order ${o.orderNo} by mistake. Your order has not shipped yet, so please disregard the tracking number in that email. We will email you again with the correct tracking number once it ships.${SIGN_OFF}`,
  }),
  // 第三轮缺口 P2-12：部分退款（AJ-383）此前买家完全不可见——没有邮件、订单状态也不变
  'order.partially_refunded': (o) => ({
    subject: `Partial refund issued for order ${o.orderNo}`,
    text: `A partial refund for order ${o.orderNo} has been issued to your original payment method. It may take 5-10 business days to appear on your statement. Open the order in the mini program to see the details.${SIGN_OFF}`,
  }),
  'order.refunded': (o) => ({
    subject: `Refund issued for order ${o.orderNo}`,
    text: `A full refund for order ${o.orderNo} has been issued to your original payment method. It may take 5-10 business days to appear on your statement.${SIGN_OFF}`,
  }),
};
