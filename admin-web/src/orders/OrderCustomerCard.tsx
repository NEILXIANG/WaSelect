/**
 * 职责：订单详情右栏的**客户卡片**（AJ-404；对标分析 §4.2 第 168 行）——"这个人买过几次、一共多少、被拉黑没有"，
 *       并链到客户详情页（地址簿 / 全部订单 / 拉黑与解除都在那边）。
 *
 * @why 统计来自服务端 `customer`（口径与客户页同一份：排除测试单、累计不扣退款），前端不自己数：
 *      详情页手里只有这一单，自己数只会数出 1。
 * @limitation 旧服务端没有 `customer` 键时只给链接（按 `user_id`），不显示统计——宁可少一块，不显示 0 单。
 * @see ../customers/CustomerDetail.tsx；../../../server/src/adapters/customers-admin.ts
 */
import { moneyText } from '../format.js';
import type { AdminOrderLike } from './api.js';

export function OrderCustomerCard({ order }: { order: AdminOrderLike }) {
  const c = order.customer;
  const userId = c?.user_id ?? order.user_id;
  if (userId === undefined || userId === '') return null;
  return (
    <div className="field">
      <span className="label">客户</span>
      {c !== undefined && (
        <span>
          历史 {c.order_count ?? 0} 单 · 累计实付 {moneyText(c.paid_total_jpy)}
          {c.blocked === true && (
            <>
              {' · '}
              <span className="error">已拉黑</span>
            </>
          )}
        </span>
      )}
      <a className="link" href={`#/customers/${encodeURIComponent(userId)}`}>
        查看客户
      </a>
    </div>
  );
}
