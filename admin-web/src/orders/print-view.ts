/**
 * 职责：「打印拣货单与面单信息」的**视图模型**（AJ-407，§4 第 134 行）——把几张订单详情（`AdminOrder`）
 *       变成一页可打印的数据：每单一块，上半拣货（采购快照），下半面单信息（收件地址 + 申报品项）。
 * 边界：纯函数，不发请求、不读时间、不碰 DOM（打印页 PrintSheet.tsx 只负责取数与渲染）。
 *
 * @why 只收 **paid（待发货）** 的单：拣货与贴面单是"已付款、还没发"的动作；
 *      其它状态的单被选中（全部页签也能勾选）时列入 `skipped`，页面明说"这几单不是待发货，未列入"，
 *      而不是静默丢掉（运营会以为漏打了）。
 * @why 拣货行复用 `purchaseLine` 的口径（字段缺失写「未记录」），申报品项缺 HS / 英文品名时同样写「未记录」：
 *      与报关清单 CSV 不同，详情接口**不用商品当前值兜底**（CSV 会兜底并标 `snapshot=current`）——
 *      打印页不替运营猜，缺什么就让它显眼地缺。
 * @why 申报价取行项目的 `declared_value_usd`（**美分整数**，契约 0.6.48）原样换算成美元显示，不在前端重算：
 *      申报基数 = 商品小计、按行分摊（create-order.ts @limitation 二；按成交价申报由 AJ-142 定案，
 *      jp 决策日志 D-61 ③ 定"申报价按内容品价格"）——前端重算就是第二份口径。
 * @limitation 一：**不是承运商面单**。系统不对接任何承运商接口（CLAUDE.md「完全自研，不引入第三方交付物」；
 *              当前通关口径是日本邮便邮寄包裹，面单 / 税関告知書在邮局或承运商系统填写，D-61），
 *              这里只是把要抄上去的信息排在一页上。页面抬头写明这一点（PRINT_NOTICE）。
 * @limitation 二：不含原产国（报关清单 CSV 有，取自商品当前值；详情接口没有这一列）。
 * @limitation 三：电话只认 `+1` + 10 位（地址校验的唯一合法形态）排成 `+1 (415) 555-0123`；其它形态原样显示，不猜。
 * @see ./PrintSheet.tsx；./view.ts purchaseLine；server/src/adapters/exports.ts customsTable
 */
import { minorMoneyText } from '../format.js';
import { PURCHASE_UNRECORDED, shipGate } from './view.js';

/** 打印页抬头的说明（@limitation 一）。 */
export const PRINT_NOTICE =
  '本页是拣货与面单信息参考，不是承运商面单：系统不对接承运商接口，面单与报关单请在邮局 / 承运商系统按本页信息填写。';

export interface PickLine {
  title: string;
  titleJa: string;
  jan: string;
  source: string;
  qty: number;
}

export interface DeclaredLine {
  desc: string;
  hs: string;
  qty: number;
  weightText: string;
  valueText: string;
}

export interface PrintOrder {
  id: string;
  orderNo: string;
  pick: PickLine[];
  recipient: string;
  /** 英文地址，按面单书写顺序一行一项（line1 / line2 / city, state postal / country）。 */
  addressLines: string[];
  phone: string;
  declared: DeclaredLine[];
  /** 申报合计（各行美分相加后再换算，不是各行美元字符串相加）。 */
  declaredTotalText: string;
}

export interface PrintModel {
  orders: PrintOrder[];
  /** 被选中但不是 paid 的单号（页面列出来，@why 第一段）。 */
  skipped: string[];
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const orUnrecorded = (v: unknown): string => (text(v) === '' ? PURCHASE_UNRECORDED : text(v));
const int = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);

/** `+14155550123` → `+1 (415) 555-0123`；其它形态原样（@limitation 三）。 */
export function phoneText(raw: unknown): string {
  const s = text(raw);
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(s);
  return m === null ? s || '—' : `+1 (${m[1]}) ${m[2]}-${m[3]}`;
}

function addressLines(a: Record<string, unknown>): string[] {
  const cityLine = [text(a['city']), [text(a['state']), text(a['postal_code'])].join(' ').trim()]
    .filter((s) => s !== '')
    .join(', ');
  return [text(a['line1']), text(a['line2']), cityLine, text(a['country'])].filter((s) => s !== '');
}

function toPrintOrder(o: Record<string, unknown>): PrintOrder {
  const items = Array.isArray(o['items']) ? o['items'].map(rec) : [];
  const addr = rec(o['address']);
  let totalCents = 0;
  let totalKnown = true;
  const declared = items.map((it): DeclaredLine => {
    const cents = int(it['declared_value_usd']);
    if (cents === null) totalKnown = false;
    else totalCents += cents;
    const w = int(it['weight_g']);
    return {
      desc: orUnrecorded(it['customs_desc_en']),
      hs: orUnrecorded(it['hs_code']),
      qty: int(it['qty']) ?? 0,
      weightText: w === null ? '—' : `${String(w)} g`,
      valueText: cents === null ? '—' : minorMoneyText(cents, 'USD'),
    };
  });
  return {
    id: text(o['order_id']),
    orderNo: text(o['order_no']) || text(o['order_id']),
    pick: items.map((it) => ({
      title: text(it['title']),
      titleJa: orUnrecorded(it['title_ja']),
      jan: orUnrecorded(it['jan_code']),
      source: orUnrecorded(it['purchase_source']),
      qty: int(it['qty']) ?? 0,
    })),
    recipient: text(addr['recipient']) || '—',
    addressLines: addressLines(addr),
    phone: phoneText(addr['phone']),
    declared,
    declaredTotalText: totalKnown && items.length > 0 ? minorMoneyText(totalCents, 'USD') : '—',
  };
}

/** 订单详情数组（按勾选顺序）→ 打印模型。 */
export function printModel(orders: readonly unknown[]): PrintModel {
  const out: PrintModel = { orders: [], skipped: [] };
  for (const raw of orders) {
    const o = rec(raw);
    // 与「待发货」页签勾选、详情页发货按钮同一个闸门（拒付中 / 测试单不能打）：
    //   审查 2026-10-09 #5——"全部"页签勾一张拒付中的 paid 单也能打出拣货单，仓库会照单采购打包
    if (shipGate(o).ok) out.orders.push(toPrintOrder(o));
    else out.skipped.push(text(o['order_no']) || text(o['order_id']));
  }
  return out;
}
