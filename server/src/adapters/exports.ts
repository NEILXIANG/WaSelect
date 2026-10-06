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
 * @limitation 二：表头是英文蛇形（与契约字段同名）：报关代理与运营共用一份，改中文表头要两边确认。
 * @limitation 三：purchase / customs 固定 status = paid（"已付未发"才需要采购和报关），不开放过滤。
 * @see app/admin-export-routes.ts；domain/csv.ts
 */
import type { Db } from './db.js';
import type { CsvCell } from '../domain/csv.js';

export const EXPORT_KINDS = ['orders', 'purchase', 'customs'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportTable {
  header: string[];
  rows: CsvCell[][];
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
const usd = (cents: unknown): string | null =>
  cents === null || cents === undefined ? null : (Number(cents) / 100).toFixed(2);

async function ordersTable(db: Db, status: string | undefined): Promise<ExportTable> {
  const rows = await db`
    select order_no, status, created_at, paid_at, shipped_at, items_jpy, shipping_jpy, duty_jpy, total_jpy,
           address_snapshot ->> 'recipient' as recipient, address_snapshot ->> 'state' as state,
           address_snapshot ->> 'country' as country, carrier, tracking_no
      from orders
     where is_test = false and (${status === undefined ? db`true` : db`status = ${status}`})
     order by created_at desc, id desc`;
  return {
    header: [
      'order_no',
      'status',
      'created_at',
      'paid_at',
      'shipped_at',
      'items_jpy',
      'shipping_jpy',
      'duty_jpy',
      'total_jpy',
      'recipient',
      'state',
      'country',
      'carrier',
      'tracking_no',
    ],
    rows: rows.map((r) => [
      str(r['order_no']),
      str(r['status']),
      iso(r['created_at']),
      iso(r['paid_at']),
      iso(r['shipped_at']),
      num(r['items_jpy']),
      num(r['shipping_jpy']),
      num(r['duty_jpy']),
      num(r['total_jpy']),
      str(r['recipient']),
      str(r['state']),
      str(r['country']),
      str(r['carrier']),
      str(r['tracking_no']),
    ]),
  };
}

async function purchaseTable(db: Db): Promise<ExportTable> {
  const rows = await db`
    select o.order_no, o.paid_at, oi.product_id, oi.title_snapshot, oi.title_ja, oi.jan_code, oi.purchase_source,
           oi.qty, oi.unit_price_jpy, oi.cost_jpy
      from order_items oi join orders o on o.id = oi.order_id
     where o.status = 'paid' and o.is_test = false
     order by o.paid_at, o.id, oi.id`;
  return {
    header: [
      'order_no',
      'paid_at',
      'product_id',
      'title',
      'title_ja',
      'jan_code',
      'purchase_source',
      'qty',
      'unit_price_jpy',
      'cost_jpy',
    ],
    rows: rows.map((r) => [
      str(r['order_no']),
      iso(r['paid_at']),
      str(r['product_id']),
      str(r['title_snapshot']),
      str(r['title_ja']),
      str(r['jan_code']),
      str(r['purchase_source']),
      num(r['qty']),
      num(r['unit_price_jpy']),
      num(r['cost_jpy']),
    ]),
  };
}

async function customsTable(db: Db): Promise<ExportTable> {
  const rows = await db`
    select o.order_no, o.address_snapshot as a, oi.qty, oi.weight_g, oi.declared_value_usd,
           coalesce(oi.hs_code, p.hs_code) as hs_code,
           coalesce(oi.customs_desc_en, p.customs_desc_en) as customs_desc_en,
           p.origin_country,
           case when oi.hs_code is null or oi.customs_desc_en is null then 'current' else 'snapshot' end as snapshot
      from order_items oi
      join orders o on o.id = oi.order_id
      join products p on p.id = oi.product_id
     where o.status = 'paid' and o.is_test = false
     order by o.paid_at, o.id, oi.id`;
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
        str(a['phone']),
        str(a['line1']),
        str(a['line2']),
        str(a['city']),
        str(a['state']),
        str(a['postal_code']),
        str(a['country']),
        str(r['customs_desc_en']),
        str(r['hs_code']),
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
  opts: { status?: string | undefined },
): Promise<ExportTable> {
  if (kind === 'orders') return ordersTable(db, opts.status);
  if (kind === 'purchase') return purchaseTable(db);
  return customsTable(db);
}
