/**
 * 职责：批量发货的**纯函数**（AJ-401）——CSV 解码 / 解析 / 表头识别 / 预检、勾选行的校验、
 *      提交体与逐单结果的转述。组件（ShipBatchDrawer / CsvShipImport）只负责取数与渲染。
 *
 * @why 预检**全部**在提交前做完、按行指出问题（未知单号 / 不可发货 / 重复 / 运单号缺失或超长 / 形状认不出），
 *      而不是"交给服务端逐行报错"：发货一确认就发邮件给买家，能在提交前挡掉的错误不该变成一封错邮件。
 *      服务端仍是最终闸门（同一单的拒付可能在预检与提交之间发生）。
 * @why 校验复用单单发货的同一份（`shipGate` / `shipErrors` / shared `trackingNoRecognized`）：
 *      第二份规则必然漂移（与 ShipForm 同一条理由）。
 * @why 表头**必须有**、按别名识别（中 / 日 / 英，NFKC 归一后比较）：没有表头时只能按列序猜，
 *      而"承运商与运单号两列对调"在列序模式下会被静默接受——运单号字段里写着 Japan Post，形状警告才拦得住一半。
 * @why 重复的单号**每一行都标错**，不替运营挑"哪一行是对的"：两行运单号不同时，挑错一行就是错邮件。
 *
 * @limitation 一：只认逗号分隔（Excel「CSV」与「CSV UTF-8」两种导出都是逗号）；制表符分隔的 TSV 认不出表头 → 文件级报错。
 * @limitation 二：编码只试 UTF-8 与 Shift_JIS（日本 Excel 默认）；GBK 导出的中文表头会解成乱码 → 表头认不出、文件级报错，不会静默错位。
 * @limitation 三：单号查找由调用方给（`OrderLookup`）；预检之后、提交之前状态仍可能变，结果以服务端逐单回执为准。
 * @see ./view.ts（shipGate / shipErrors）；../../../server/src/app/admin-ship-batch-routes.ts
 */
import { parseOrderNoDate, SHIP_BATCH_MAX, trackingNoRecognized } from '@waselect/shared';
import { ORDER_STATUS_LABELS, shipErrors, shipGate } from './view.js';
import type { AdminOrderLike } from './api.js';
// 形状警告与单单发货 / 改运单号同一句（续作复核修正：原先另写了一句近义文案，两处会漂移）
import { TRACKING_SHAPE_WARNING } from './fix-view.js';

/** 一行待发货（CSV 行或勾选行同形）。 */
export interface BatchRow {
  /** CSV 行号（表头 = 1）；勾选模式为 0。 */
  line: number;
  orderNo: string;
  orderId: string | null;
  carrier: string;
  trackingNo: string;
  /** 订单级问题（找不到 / 不可发货），构造行时定下，编辑承运商 / 运单号不改变它。 */
  blockers: string[];
  /** 订单级提醒（只提示不拦，如下单人已拉黑），构造行时定下；validateRows 每次带进 warnings。 */
  orderWarnings: string[];
  /** = blockers + 重复 + 字段错误（由 validateRows 重算）；非空即不提交。 */
  errors: string[];
  warnings: string[];
}

/** order_no → 订单（列表接口的形状）。 */
export type OrderLookup = ReadonlyMap<string, AdminOrderLike>;

/** 字节 → 文本：合法 UTF-8 按 UTF-8（自动去 BOM），否则按 Shift_JIS。 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // @measured(Node 22.22.2, 2026-10-07)：fatal 解码 SJIS 字节抛 TypeError ERR_ENCODING_INVALID_ENCODED_DATA；
    //   new TextDecoder('shift_jis') 把 92 8D 95 B6 94 D4 8D 86 解成「注文番号」；默认 utf-8 解码会去掉 BOM。
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

/** 一条 CSV 记录：`line` 是它在文件里**起始的物理行号**（1 起）。 */
export interface CsvRecord {
  line: number;
  cells: string[];
}

/**
 * RFC 4180 风格解析：引号字段可含逗号 / 换行 / `""`；CRLF、LF、CR 都算换行；全空行丢弃。
 * @why 每条记录带**物理行号**（AJ-401 续作复核修正）：原先按"第几条记录 + 2"推行号，
 *      文件中间有空行或引号内换行时，预检表报的行号与编辑器 / Excel 里看到的对不上，运营会去改错的那一行。
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const src = text.replace(/^\uFEFF/, '');
  const out: CsvRecord[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRow = (): void => {
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) out.push({ line: start, cells: row });
    row = [];
    cell = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const nl = ch === '\n' || (ch === '\r' && src[i + 1] !== '\n');
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      if (nl) line++;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
      line++;
      start = line;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) endRow();
  return out;
}

/** 只要单元格（不关心行号的调用方与用例）。 */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).map((r) => r.cells);
}

/**
 * CSV 里的订单号 → 归一形（NFKC + trim + 大写）。
 * @why 订单号是 `YYMMDD-XXXXXX`（shared formatOrderNo，Crockford Base32 大写）；日文输入法手打常是全角或小写，
 *      归一后是同一单。只归一订单号这个**标识**，不归一运单号：运单号会原样存库、进查件链接，
 *      静默改写它等于替运营改数据——全角运单号由形状警告提示（trackingNoRecognized 认不出）。
 * @measured(Node 22.22.2, 2026-10-07)：`'２６１００７－７ｋ３ｑｘａ'` → `"261007-7K3QXA"`（全角 U+FF0D 归成 `-`）；
 *   `'261007ー7K3QXA'`（长音符）与 `'261007‐7K3QXA'`（U+2010）**原样不变**。
 * @limitation 长音符 / U+2010 这类"看着像横杠"的字符不归一 → 该行标"格式不对"（看得见，不会静默对错单）。
 */
export function normalizeOrderNo(raw: string): string {
  return raw.normalize('NFKC').trim().toUpperCase();
}
const ORDER_NO_SHAPE_HINT = '订单号格式不对（应为 YYMMDD-XXXXXX，如 261007-7K3QXA）';
const wellFormedOrderNo = (no: string): boolean => parseOrderNoDate(no) !== undefined;

/** 表头别名（归一后比较：NFKC、小写、去空白与 `_` `-`）。 */
const HEADER_ALIASES = {
  orderNo: [
    'orderno',
    'order',
    '订单号',
    '订单编号',
    '单号',
    '注文番号',
    '注文no',
    'オーダー番号',
    '受注番号',
  ],
  carrier: ['carrier', '承运商', '快递公司', '物流公司', '配送業者', '運送会社', '配送会社'],
  trackingNo: [
    'trackingno',
    'tracking',
    '运单号',
    '快递单号',
    '物流单号',
    '追跡番号',
    'お問い合わせ番号',
    'お問合せ番号',
    '伝票番号',
  ],
} as const;

const normHeader = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_-]/g, '');

export function readCsvColumns(
  header: readonly string[],
):
  | { ok: true; orderNo: number; carrier: number | null; trackingNo: number }
  | { ok: false; error: string } {
  const find = (names: readonly string[]): number => {
    const i = header.findIndex((h) => names.includes(normHeader(h)));
    return i;
  };
  const orderNo = find(HEADER_ALIASES.orderNo);
  const carrier = find(HEADER_ALIASES.carrier);
  const trackingNo = find(HEADER_ALIASES.trackingNo);
  const missing = [
    orderNo < 0 ? '订单号（order_no）' : '',
    trackingNo < 0 ? '运单号（tracking_no）' : '',
  ].filter((x) => x !== '');
  if (missing.length > 0) {
    return { ok: false, error: `第 1 行表头缺少列：${missing.join('、')}` };
  }
  return { ok: true, orderNo, carrier: carrier < 0 ? null : carrier, trackingNo };
}

/** 逐行重算 errors / warnings：订单级 blockers + 重复 + 字段校验（勾选模式每次编辑后都调）。 */
export function validateRows(rows: readonly BatchRow[]): BatchRow[] {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.orderNo, (count.get(r.orderNo) ?? 0) + 1);
  // 同一运单号出现在多单：合并包裹时是真实形态，所以只警告不拦（模拟走查 2026-10-09：此前静默放行，填串行查不出来）
  const trackingCount = new Map<string, number>();
  for (const r of rows) {
    const t = r.trackingNo.trim().toUpperCase();
    if (t !== '') trackingCount.set(t, (trackingCount.get(t) ?? 0) + 1);
  }
  return rows.map((r) => {
    const errors = [...r.blockers];
    if (r.orderNo !== '' && (count.get(r.orderNo) ?? 0) > 1) errors.push('同一单号重复出现');
    const field = shipErrors({ carrier: r.carrier, trackingNo: r.trackingNo });
    const fieldErrors = Object.values(field.errors);
    // A-10（AJ-464）：Excel 把长数字运单号改成科学计数法（1.23457E+11）——这不是"形状认不出"的黄字，而是**一定错**的号：
    //   原号已经丢了几位，进了买家的发货邮件就是一个查不到的单号。直接拦，并告诉运营怎么修。
    if (SCIENTIFIC_NOTATION.test(r.trackingNo.trim())) errors.push(SCIENTIFIC_TRACKING_ERROR);
    const warnings: string[] = [...r.orderWarnings];
    if (r.trackingNo.trim() !== '' && !trackingNoRecognized(r.carrier, r.trackingNo))
      warnings.push(TRACKING_SHAPE_WARNING);
    if ((trackingCount.get(r.trackingNo.trim().toUpperCase()) ?? 0) > 1)
      warnings.push(DUPLICATE_TRACKING_WARNING);
    return { ...r, errors: [...errors, ...fieldErrors], warnings };
  });
}

/** `1.23457E+11` / `1.2E11` 这类形态 = Excel 的科学计数法，原号已丢位。 */
const SCIENTIFIC_NOTATION = /^\d+(?:\.\d+)?E\+?\d+$/i;
export const SCIENTIFIC_TRACKING_ERROR =
  '运单号被 Excel 改成了科学计数法（如 1.23457E+11），原号已丢失：请在 Excel 里把该列设为"文本"后重新导出';

/** 多单共用一个运单号时的提醒（只警告：合并包裹是真实形态；填串行时这一行会亮黄）。 */
export const DUPLICATE_TRACKING_WARNING = '运单号与另一单相同：合并包裹才会这样，请确认没有填串行';

/**
 * 下单人已被拉黑（联动走查·熟手运营 2026-10-10）。
 * @why 勾选里混进拉黑用户的已付单时，批量抽屉里那一行与别的单一模一样——列表上的「用户已拉黑」徽章到这里就看不见了。
 *      只提示不拦：这类单可能照发（AJ-425：发货前要判断退款还是照发），但不能没看见就发出去。
 */
export const BLOCKED_USER_WARNING = '下单人已被拉黑：请先确认是退款还是照常发货';

/** 订单级提醒（不拦提交）。 */
function orderWarnings(order: AdminOrderLike | undefined): string[] {
  return order?.user_blocked === true ? [BLOCKED_USER_WARNING] : [];
}

/** 订单级判定（与详情页发货按钮同一个 shipGate）。 */
function orderBlockers(orderNo: string, order: AdminOrderLike | undefined): string[] {
  if (orderNo === '') return ['订单号为空'];
  if (order === undefined)
    return [wellFormedOrderNo(orderNo) ? '找不到这个订单号' : ORDER_NO_SHAPE_HINT];
  const gate = shipGate(order);
  if (gate.ok) return [];
  const label = ORDER_STATUS_LABELS[order.status as keyof typeof ORDER_STATUS_LABELS] ?? '';
  return [`${gate.reason}${label === '' ? '' : `（当前：${label}）`}`];
}

/** 文件级检查（表头 / 空 / 超上限）：通过 → 列位置；不通过 → 文案。 */
function csvShape(
  records: readonly CsvRecord[],
):
  | { ok: true; cols: { orderNo: number; carrier: number | null; trackingNo: number } }
  | { ok: false; error: string } {
  const [header, ...data] = records;
  if (header === undefined || data.length === 0) return { ok: false, error: '文件里没有数据行' };
  const cols = readCsvColumns(header.cells);
  if (!cols.ok) return cols;
  if (data.length > SHIP_BATCH_MAX) {
    return {
      ok: false,
      error: `一次最多 ${String(SHIP_BATCH_MAX)} 行，这个文件有 ${String(data.length)} 行，请拆开导入`,
    };
  }
  return { ok: true, cols };
}

/**
 * 预检要查的订单号（已归一、去重前的原序；只含**形状对**的）。文件级不通过 → 空（一次查询都不发）。
 * @why 形状不对的不拿去查：查也查不到，且超过 keyword 上限（64）的脏值会让列表接口 400、整次预检中断。
 */
export function csvOrderNos(records: readonly CsvRecord[]): string[] {
  const shape = csvShape(records);
  if (!shape.ok) return [];
  return records
    .slice(1)
    .map((r) => normalizeOrderNo(r.cells[shape.cols.orderNo] ?? ''))
    .filter(wellFormedOrderNo);
}

/** CSV 记录 → 预检行；文件级问题（空 / 表头 / 超上限）放 `error`。 */
export function buildCsvPreview(
  records: readonly CsvRecord[],
  lookup: OrderLookup,
  defaultCarrier: string,
): { error: string; rows: BatchRow[] } {
  const shape = csvShape(records);
  if (!shape.ok) return { error: shape.error, rows: [] };
  const { cols } = shape;
  const rows = records.slice(1).map(({ line, cells }): BatchRow => {
    const orderNo = normalizeOrderNo(cells[cols.orderNo] ?? '');
    const ownCarrier = cols.carrier === null ? '' : (cells[cols.carrier] ?? '').trim();
    const order = lookup.get(orderNo);
    return {
      line,
      orderNo,
      orderId: order?.order_id ?? null,
      carrier: ownCarrier === '' ? defaultCarrier.trim() : ownCarrier,
      trackingNo: (cells[cols.trackingNo] ?? '').trim(),
      blockers: orderBlockers(orderNo, order),
      orderWarnings: orderWarnings(order),
      errors: [],
      warnings: [],
    };
  });
  return { error: '', rows: validateRows(rows) };
}

/** 勾选的订单 → 可编辑行（承运商预填默认值）。 */
export function selectionRows(
  orders: readonly AdminOrderLike[],
  defaultCarrier: string,
): BatchRow[] {
  return orders.map((o) => ({
    line: 0,
    orderNo: o.order_no ?? o.order_id,
    orderId: o.order_id,
    carrier: defaultCarrier.trim(),
    trackingNo: '',
    blockers: orderBlockers(o.order_no ?? o.order_id, o),
    orderWarnings: orderWarnings(o),
    errors: [],
    warnings: [],
  }));
}

/** 只有没有错误、且对上了订单 id 的行进提交体。 */
export function toBatchItems(
  rows: readonly BatchRow[],
): { order_id: string; carrier: string; tracking_no: string }[] {
  return rows
    .filter((r) => r.errors.length === 0 && r.orderId !== null)
    .map((r) => ({
      order_id: r.orderId as string,
      carrier: r.carrier.trim(),
      tracking_no: r.trackingNo.trim(),
    }));
}

/** 服务端逐单结果 → 一句话（与契约 0.6.45 的 reason 一一对应；认不出的 reason 用服务端 message）。 */
export function describeResult(r: {
  ok?: unknown;
  code?: unknown;
  reason?: unknown;
  message?: unknown;
  tracking_recognized?: unknown;
}): { ok: boolean; text: string } {
  if (r.ok === true) {
    return r.tracking_recognized === false
      ? { ok: true, text: '已发货；但运单号形状认不出，请核对（录错可在详情「修改运单号」里改）' }
      : // 全入口点击测试 2026-10-11：原写"发货邮件已发出"——只发给留了邮箱的买家，且此刻只是排进发送队列
        { ok: true, text: '已发货（留了邮箱的买家会收到发货邮件）' };
  }
  const reason = typeof r.reason === 'string' ? r.reason : '';
  const fixed: Record<string, string> = {
    status_shipped: '这一单已是「已发货」，没有重复发货',
    dispute_open: '有拒付进行中，不能发货',
    test_order: '审核期测试单，不得发货',
    not_found: '订单不存在',
    status_raced: '状态刚被别人改了，请刷新列表再看',
    internal: '服务器内部错误，这一单没有发出（可单独重试）',
    carrier_tracking_no_required: '承运商与运单号必填',
    carrier_too_long: '承运商太长',
    tracking_no_too_long: '运单号太长',
  };
  const known = fixed[reason];
  if (known !== undefined) return { ok: false, text: known };
  const st = reason.startsWith('status_') ? reason.slice('status_'.length) : '';
  const label = ORDER_STATUS_LABELS[st as keyof typeof ORDER_STATUS_LABELS];
  if (label !== undefined) return { ok: false, text: `当前状态「${label}」，不能发货` };
  const msg = typeof r.message === 'string' && r.message !== '' ? r.message : '发货失败';
  return { ok: false, text: `${msg}（${String(r.code ?? '')}）` };
}
