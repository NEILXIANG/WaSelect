/**
 * 职责：三类 CSV 导出的查询（剩余清单 3-3）——返回二维表（表头 + 行），由路由层编码成 CSV。
 *   orders    订单总表（一单一行；可按 status 过滤）
 *   purchase  待采购清单（paid 单的行项目 + 采购快照）
 *   customs   待发货报关（paid 单的行项目 + 收件地址 + 报关快照）
 *
 * @why 一律排除 `is_test`（审核期 mock 单）：它们不该被采购、不该被报关，混进表里就会被当真单处理。
 * @why 报关 / 采购取 order_items 的**快照**列（迁移 021 / 027），不 JOIN products 当前值：
 *      导出给报关代理的必须是下单那一刻的品名与 HS 码（同 AJ-368 ③）。
 *      快照为 NULL 的历史行用 products 当前值兜底，并在 `snapshot` 列标 `current`，让人知道这一格不是快照。
 * @why 申报价存的是美分（BIGINT，create-order 用 toMinor 分摊），导出转成两位小数的美元：报关单填的是美元。
 * @limitation 一：不分页、不流式（见 domain/csv.ts）；
 * @limitation 二：报关表（customs）表头是英文蛇形（与契约字段同名）：报关代理与运营共用一份，改中文表头要两边确认。
 *              订单总表与采购单是内部用表，AJ-494 起改中文表头、状态写中文（运营在 Excel 里读不懂英文字段与代号）。
 * @limitation 三：purchase / customs 固定 status = paid（"已付未发"才需要采购和报关），不开放过滤；
 *              「导出所选」（`orderIds`，AJ-407）与它是 AND——所选里的已发货单不会出现在采购 / 报关表里。
 * @limitation 四：`orderIds` 只是**过滤**：不存在的 id 静默不出（不报错，与列表筛选同口径）；测试单即便被选中也不出。
 *              行数不再与"勾了几单"相等——审计里另记 selected（路由层）。
 * @see app/admin-export-routes.ts；domain/csv.ts
 */
import type { Db } from './db.js';
import { asText, type CsvCell } from '../domain/csv.js';
import { CURRENCY_MINOR_DIGITS, type CurrencyCode, ORDER_STATUS_LABELS } from '@waselect/shared';

export const EXPORT_KINDS = ['orders', 'purchase', 'customs'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportTable {
  header: string[];
  rows: CsvCell[][];
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/**
 * 日本时间 `YYYY-MM-DD HH:mm:ss`（第三轮缺口 P2-46，AJ-386）：管理端页面全部是 JST，导出原先是 UTC `…Z`，
 * 运营对照列表与 CSV 差 9 小时，按日统计会错一天。表头相应带 `_jst` 后缀，读的人不用猜时区。
 * @why 不用 Intl：结果只取决于 UTC 时刻 + 固定 9 小时（日本无夏令时），纯算术最确定。
 */
const jst = (v: unknown): string | null =>
  v instanceof Date
    ? new Date(v.getTime() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    : null;
/**
 * `orderIds` → SQL 片段（AJ-407）：没给 = 不限；给了 = `o.id in (…)`。
 * @why 三张表共用一个片段：任何一张漏接，"导出所选"就会导出**全部**——多出的单会被当成要采购 / 要报关的单。
 */
function idFilter(db: Db, col: 'id' | 'o.id', ids: readonly string[] | undefined) {
  if (ids === undefined) return db`true`;
  return col === 'id' ? db`id in ${db([...ids])}` : db`o.id in ${db([...ids])}`;
}

const usd = (cents: unknown): string | null =>
  cents === null || cents === undefined ? null : (Number(cents) / 100).toFixed(2);

async function ordersTable(
  db: Db,
  status: string | undefined,
  ids: readonly string[] | undefined,
): Promise<ExportTable> {
  const rows = await db`
    select o.order_no, o.status, o.created_at, o.paid_at, o.shipped_at, o.items_jpy, o.shipping_jpy, o.duty_jpy, o.total_jpy,
           o.address_snapshot ->> 'recipient' as recipient, o.address_snapshot ->> 'state' as state,
           o.address_snapshot ->> 'country' as country, o.carrier, o.tracking_no,
           -- ADM-3（AJ-451）：买家实付币种与金额 = 最新一条成功支付行；没有成功支付行两列为空（不编 0）
           p.charge_currency as paid_currency, p.charge_amount as paid_minor
      from orders o
      left join lateral (
        select charge_currency, charge_amount from payments
         where order_id = o.id and status in ('succeeded', 'refunded')
         order by created_at desc, id desc limit 1
      ) p on true
     where o.is_test = false and (${status === undefined ? db`true` : db`status = ${status}`})
       and (${idFilter(db, 'o.id', ids)})
     order by o.created_at desc, o.id desc`;
  return {
    // AJ-494：中文表头（内部用表）；"订单号 / 运单号 / 承运商"与导入运单号认的表头同名，改好可直接导回。
    // AJ-495：金额单位写「日元」不写「円」（用户 2026-10-12：中文运营认不得「円」；契约 0.6.77）
    header: [
      '订单号',
      '状态',
      '下单时间（日本时间）',
      '付款时间（日本时间）',
      '发货时间（日本时间）',
      '商品金额（日元）',
      '运费（日元）',
      '预估关税（日元）',
      '订单合计（日元）',
      '收件人',
      '州',
      '国家',
      '承运商',
      '运单号',
      '实付币种',
      '实付金额',
    ],
    rows: rows.map((r) => [
      str(r['order_no']),
      statusLabel(r['status']),
      jst(r['created_at']),
      jst(r['paid_at']),
      jst(r['shipped_at']),
      num(r['items_jpy']),
      num(r['shipping_jpy']),
      num(r['duty_jpy']),
      num(r['total_jpy']),
      str(r['recipient']),
      str(r['state']),
      str(r['country']),
      str(r['carrier']),
      asText(str(r['tracking_no'])),
      str(r['paid_currency']),
      paidAmount(r['paid_currency'], r['paid_minor']),
    ]),
  };
}

/** 最小单位 → 币种习惯写法（USD 8600 → "86.00"，JPY 1650 → "1650"）；币种不认识时原样给最小单位。 */
function paidAmount(currency: unknown, minor: unknown): string | null {
  if (minor === null || minor === undefined) return null;
  const digits =
    typeof currency === 'string' && currency in CURRENCY_MINOR_DIGITS
      ? CURRENCY_MINOR_DIGITS[currency as CurrencyCode]
      : 0;
  const n = Number(minor);
  if (digits === 0) return String(n);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const base = 10 ** digits;
  return `${sign}${String(Math.floor(abs / base))}.${String(abs % base).padStart(digits, '0')}`;
}

async function purchaseTable(db: Db, ids: readonly string[] | undefined): Promise<ExportTable> {
  const rows = await db`
    select o.order_no, o.paid_at, oi.product_id, oi.title_snapshot, oi.title_ja, oi.jan_code, oi.purchase_source,
           oi.qty, oi.unit_price_jpy, oi.cost_jpy
      from order_items oi join orders o on o.id = oi.order_id
     where o.status = 'paid' and o.is_test = false and (${idFilter(db, 'o.id', ids)})
     order by o.paid_at, o.id, oi.line_no nulls last, oi.id`;
  return {
    // AJ-494：中文表头（内部用表）；36 位商品 id 挪到最后一列（只核对用，采购员不需要看）
    header: [
      '订单号',
      '付款时间（日本时间）',
      '商品名',
      '日文原名',
      'JAN 码',
      '采购来源',
      '数量',
      '售价（日元）',
      '成本（日元）',
      '商品编号（系统）',
    ],
    rows: rows.map((r) => [
      str(r['order_no']),
      jst(r['paid_at']),
      str(r['title_snapshot']),
      str(r['title_ja']),
      asText(str(r['jan_code'])),
      str(r['purchase_source']),
      num(r['qty']),
      num(r['unit_price_jpy']),
      num(r['cost_jpy']),
      str(r['product_id']),
    ]),
  };
}

/** 订单状态 → 中文（shared 词表）；认不出的原样输出（不编）。 */
function statusLabel(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  return (ORDER_STATUS_LABELS as Record<string, string>)[s] ?? s;
}

async function customsTable(db: Db, ids: readonly string[] | undefined): Promise<ExportTable> {
  const rows = await db`
    select o.order_no, o.address_snapshot as a, oi.qty, oi.weight_g, oi.declared_value_usd,
           coalesce(oi.hs_code, p.hs_code) as hs_code,
           coalesce(oi.customs_desc_en, p.customs_desc_en) as customs_desc_en,
           p.origin_country,
           case when oi.hs_code is null or oi.customs_desc_en is null then 'current' else 'snapshot' end as snapshot
      from order_items oi
      join orders o on o.id = oi.order_id
      join products p on p.id = oi.product_id
     where o.status = 'paid' and o.is_test = false and (${idFilter(db, 'o.id', ids)})
     order by o.paid_at, o.id, oi.line_no nulls last, oi.id`;
  return {
    header: [
      'order_no',
      'recipient',
      'phone',
      'line1',
      'line2',
      'city',
      'state',
      'postal_code',
      'country',
      'customs_desc_en',
      'hs_code',
      'origin_country',
      'qty',
      'weight_g',
      'declared_value_usd',
      'snapshot',
    ],
    rows: rows.map((r) => {
      const a = (r['a'] ?? {}) as Record<string, unknown>;
      return [
        str(r['order_no']),
        str(a['recipient']),
        asText(str(a['phone'])),
        str(a['line1']),
        str(a['line2']),
        str(a['city']),
        str(a['state']),
        asText(str(a['postal_code'])),
        str(a['country']),
        str(r['customs_desc_en']),
        asText(str(r['hs_code'])),
        str(r['origin_country']),
        num(r['qty']),
        num(r['weight_g']),
        usd(r['declared_value_usd']),
        str(r['snapshot']),
      ];
    }),
  };
}

export async function exportTable(
  db: Db,
  kind: ExportKind,
  opts: { status?: string | undefined; orderIds?: readonly string[] | undefined },
): Promise<ExportTable> {
  if (kind === 'orders') return ordersTable(db, opts.status, opts.orderIds);
  if (kind === 'purchase') return purchaseTable(db, opts.orderIds);
  return customsTable(db, opts.orderIds);
}
