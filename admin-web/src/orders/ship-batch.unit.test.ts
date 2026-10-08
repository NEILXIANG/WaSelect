/**
 * 职责：批量发货纯函数（AJ-401）的用例——CSV 解析 / 表头别名 / 预检 / 结果转述。
 *
 * @why CSV 用例的样本按**真实来源**造：Excel「CSV UTF-8」导出带 BOM + CRLF；日本的 Excel 默认 Shift_JIS；
 *      承运商后台导出的运单号常被 Excel 加引号、字段里带逗号（"Japan Post, EMS"）；运营手粘时尾部多一行空行。
 */
import { describe, expect, it } from 'vitest';
import { SHIP_BATCH_MAX } from '@waselect/shared';
import {
  DUPLICATE_TRACKING_WARNING,
  buildCsvPreview,
  csvOrderNos,
  decodeCsvBytes,
  describeResult,
  parseCsv,
  parseCsvRecords,
  readCsvColumns,
  selectionRows,
  toBatchItems,
  validateRows,
  type OrderLookup,
} from './ship-batch.js';

describe('parseCsv', () => {
  it('BOM + CRLF + 引号里的逗号 / 转义引号 / 换行；尾部空行丢掉', () => {
    const text =
      '\uFEFF注文番号,配送業者,追跡番号\r\n' +
      '261007-7K3QXA,"Japan Post, EMS",EJ123456789JP\r\n' +
      '261007-8M2WRD,"ヤマト ""国際""",4321-1234-5678\r\n' +
      '261007-9P4TZE,"佐川\n急便",SG1\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['注文番号', '配送業者', '追跡番号'],
      ['261007-7K3QXA', 'Japan Post, EMS', 'EJ123456789JP'],
      ['261007-8M2WRD', 'ヤマト "国際"', '4321-1234-5678'],
      ['261007-9P4TZE', '佐川\n急便', 'SG1'],
    ]);
  });

  it('只有 LF / 只有 CR（老 Mac 导出）都能分行；全空行跳过', () => {
    expect(parseCsv('a,b\nc,d\n\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv(' , \n')).toEqual([]);
  });
});

describe('decodeCsvBytes', () => {
  it('UTF-8（带 BOM）原样；不是合法 UTF-8 → 按 Shift_JIS（日本 Excel 默认编码）', () => {
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    // 「注文番号」的 Shift_JIS 字节
    const sjis = new Uint8Array([0x92, 0x8d, 0x95, 0xb6, 0x94, 0xd4, 0x8d, 0x86]);
    expect(decodeCsvBytes(sjis)).toBe('注文番号');
  });
});

describe('readCsvColumns：表头别名', () => {
  it.each([
    [['order_no', 'carrier', 'tracking_no']],
    [['订单号', '承运商', '运单号']],
    [['注文番号', '配送業者', 'お問い合わせ番号']],
    [[' Order No ', 'CARRIER', 'Tracking-No']],
    [['ｵｰﾀﾞｰ番号', '運送会社', '追跡番号']], // 半角片假名（NFKC 归一）
  ])('%j 认得出', (header) => {
    const r = readCsvColumns(header);
    expect(r.ok).toBe(true);
  });

  it('承运商列可缺（用默认承运商）；单号 / 运单号缺 → 指名缺哪列', () => {
    expect(readCsvColumns(['订单号', '运单号'])).toEqual({
      ok: true,
      orderNo: 0,
      carrier: null,
      trackingNo: 1,
    });
    const bad = readCsvColumns(['收件人', '承运商']);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('订单号');
    if (!bad.ok) expect(bad.error).toContain('运单号');
  });
});

/** 表格 → 记录（行号 = 下标 + 1；只给不关心行号的用例用）。 */
const rec = (t: string[][]) => t.map((cells, i) => ({ line: i + 1, cells }));

const lookup: OrderLookup = new Map([
  ['261007-7K3QXA', { order_id: 'ord_a', order_no: '261007-7K3QXA', status: 'paid' }],
  ['261007-8M2WRD', { order_id: 'ord_b', order_no: '261007-8M2WRD', status: 'shipped' }],
  [
    '261007-9P4TZE',
    { order_id: 'ord_c', order_no: '261007-9P4TZE', status: 'paid', has_dispute: true },
  ],
  ['261007-A5BCDF', { order_id: 'ord_d', order_no: '261007-A5BCDF', status: 'paid' }],
  ['261007-B6GHJK', { order_id: 'ord_e', order_no: '261007-B6GHJK', status: 'paid' }],
]);

describe('buildCsvPreview', () => {
  it('🔴 未知单号 / 不可发货 / 重复行 / 运单号缺失 / 形状认不出 各自标出；只有干净行进提交', () => {
    const csv =
      'order_no,carrier,tracking_no\r\n' +
      '261007-7K3QXA,,EJ123456789JP\r\n' + // 承运商空 → 用默认
      '261007-ZZZZZZ,Japan Post,EJ000000001JP\r\n' + // 不存在
      '261007-8M2WRD,Japan Post,EJ000000002JP\r\n' + // 已发货
      '261007-9P4TZE,Japan Post,EJ000000003JP\r\n' + // 拒付
      '261007-A5BCDF,Japan Post,\r\n' + // 运单号空
      '261007-B6GHJK,Japan Post,ABC\r\n' + // 日本邮便却不是 S10 → 警告不拦
      '261007-7K3QXA,Japan Post,EJ999999999JP\r\n'; // 与第 2 行重复
    const p = buildCsvPreview(parseCsvRecords(csv), lookup, 'Japan Post');
    expect(p.error).toBe('');
    const view = p.rows.map((r) => [r.line, r.errors.length > 0, r.warnings.length > 0]);
    expect(view).toEqual([
      [2, true, false], // 重复：两行都标（不替运营挑哪一行是对的）
      [3, true, false],
      [4, true, false],
      [5, true, false],
      [6, true, false],
      [7, false, true],
      [8, true, false],
    ]);
    expect(p.rows[1]?.errors.join()).toContain('找不到');
    expect(p.rows[2]?.errors.join()).toContain('已发货');
    expect(p.rows[3]?.errors.join()).toContain('拒付');
    expect(p.rows[0]?.errors.join()).toContain('重复');
    expect(p.rows[0]?.carrier).toBe('Japan Post');
    expect(toBatchItems(p.rows)).toEqual([
      { order_id: 'ord_e', carrier: 'Japan Post', tracking_no: 'ABC' },
    ]);
  });

  /**
   * 🔴 续作复核时发现（AJ-401）：行号按"第几条记录 + 2"算，文件中间有空行、或引号字段里有换行时，
   *    预检表报的行号与运营在 Excel / 编辑器里看到的行号对不上——她会去改错的那一行。
   */
  it('🔴 行号是文件里的**物理行号**（中间空行、引号内换行都不错位）', () => {
    const csv =
      'order_no,carrier,tracking_no\r\n' +
      '\r\n' + // 第 2 行：空行
      '261007-7K3QXA,"Japan\nPost",EJ123456789JP\r\n' + // 第 3–4 行（引号内换行）
      '261007-ZZZZZZ,Japan Post,EJ000000001JP\r\n'; // 第 5 行
    const p = buildCsvPreview(parseCsvRecords(csv), lookup, '');
    expect(p.rows.map((r) => r.line)).toEqual([3, 5]);
  });

  /**
   * 🔴 订单号的真实形态是 `YYMMDD-XXXXXX`（shared formatOrderNo，Crockford Base32 大写）。
   *    日文输入法下手打常是全角（`２６１００７－７Ｋ３ＱＸＡ`）或小写；这些按 NFKC + 大写归一后是同一单。
   *    形状都不对的（Excel 把它吃成数字、复制多了列）直接标"格式不对"，不拿去查——
   *    也就不会把超过 keyword 上限（64）的脏值发给列表接口，整次预检被 400 打断。
   */
  it('🔴 订单号：全角 / 小写归一后能对上；形状不对 → 标"格式不对"且不进查询清单', () => {
    const csv =
      'order_no,carrier,tracking_no\n' +
      '２６１００７－７ｋ３ｑｘａ,Japan Post,EJ123456789JP\n' +
      '2.61007E+11,Japan Post,EJ000000001JP\n' +
      `${'9'.repeat(80)},Japan Post,EJ000000002JP\n`;
    const records = parseCsvRecords(csv);
    expect(csvOrderNos(records)).toEqual(['261007-7K3QXA']);
    const p = buildCsvPreview(records, lookup, '');
    expect(p.rows[0]?.orderNo).toBe('261007-7K3QXA');
    expect(p.rows[0]?.orderId).toBe('ord_a');
    expect(p.rows[1]?.errors.join()).toContain('格式不对');
    expect(p.rows[2]?.errors.join()).toContain('格式不对');
  });

  it('csvOrderNos：表头认不出 / 超上限 → 空（不发任何查询）', () => {
    expect(csvOrderNos(parseCsvRecords('收件人,电话\nA,1\n'))).toEqual([]);
    const many = ['order_no,tracking_no'];
    for (let i = 0; i <= SHIP_BATCH_MAX; i++) many.push('261007-7K3QXA,EJ123456789JP');
    expect(csvOrderNos(parseCsvRecords(many.join('\n')))).toEqual([]);
  });

  it(`数据行超过 ${String(SHIP_BATCH_MAX)} → 整个文件报错（不截断）`, () => {
    const rows = [['order_no', 'tracking_no']];
    for (let i = 0; i <= SHIP_BATCH_MAX; i++) rows.push([`N${String(i)}`, 'EJ123456789JP']);
    expect(buildCsvPreview(rec(rows), lookup, '').error).toContain(String(SHIP_BATCH_MAX));
    expect(buildCsvPreview(rec(rows.slice(0, SHIP_BATCH_MAX + 1)), lookup, '').error).toBe('');
  });

  it('表头认不出 / 空文件 → 文件级错误', () => {
    expect(buildCsvPreview(rec([['a', 'b']]), lookup, '').error).not.toBe('');
    expect(buildCsvPreview(rec([]), lookup, '').error).not.toBe('');
  });
});

describe('selectionRows / validateRows（勾选模式）', () => {
  it('勾选的单带上默认承运商；同一套校验（缺运单号红、形状认不出黄）', () => {
    const rows = selectionRows(
      [
        { order_id: 'ord_a', order_no: '261007-7K3QXA', status: 'paid' },
        { order_id: 'ord_d', order_no: '261007-A5BCDF', status: 'paid' },
      ],
      'EMS',
    );
    expect(rows.map((r) => r.carrier)).toEqual(['EMS', 'EMS']);
    const checked = validateRows([
      { ...rows[0]!, trackingNo: 'EJ123456789JP' },
      { ...rows[1]!, trackingNo: '' },
    ]);
    expect(checked[0]?.errors).toEqual([]);
    expect(checked[1]?.errors.join()).toContain('运单号');
    expect(toBatchItems(checked)).toEqual([
      { order_id: 'ord_a', carrier: 'EMS', tracking_no: 'EJ123456789JP' },
    ]);
  });
});

describe('describeResult', () => {
  it.each([
    [{ ok: true, tracking_recognized: true }, '已发货'],
    [{ ok: true, tracking_recognized: false }, '形状认不出'],
    [{ ok: false, code: 40902, reason: 'status_shipped' }, '已是「已发货」'],
    [{ ok: false, code: 40902, reason: 'status_refunding' }, '退款中'],
    [{ ok: false, code: 40909, reason: 'dispute_open' }, '拒付'],
    [{ ok: false, code: 40902, reason: 'test_order' }, '测试单'],
    [{ ok: false, code: 40400, reason: 'not_found' }, '不存在'],
    [{ ok: false, code: 40902, reason: 'status_raced' }, '刷新'],
    [{ ok: false, code: 50000, reason: 'internal' }, '没有发出'],
    [{ ok: false, code: 40001, reason: 'weird', message: '参数错误' }, '参数错误'],
  ])('%j → 含「%s」', (r, text) => {
    expect(describeResult(r).text).toContain(text);
  });
});

describe('多单共用运单号 → 黄字警告，不拦（模拟走查 2026-10-09）', () => {
  it('🔴 两行运单号相同（忽略大小写）→ 两行都带警告、errors 不变；不同则无', () => {
    const base = {
      line: 0,
      orderId: 'o-1',
      orderNo: '261009-AAAAAA',
      blockers: [] as string[],
      carrier: 'Japan Post EMS',
      trackingNo: 'EJ123456789JP',
      errors: [] as string[],
      warnings: [] as string[],
    };
    const rows = validateRows([
      { ...base, orderId: 'o-1', orderNo: '261009-AAAAAA' },
      { ...base, orderId: 'o-2', orderNo: '261009-BBBBBB', trackingNo: 'ej123456789jp' },
      { ...base, orderId: 'o-3', orderNo: '261009-CCCCCC', trackingNo: 'EJ123456790JP' },
    ]);
    expect(rows.map((r) => r.warnings.includes(DUPLICATE_TRACKING_WARNING))).toEqual([
      true,
      true,
      false,
    ]);
    expect(rows.every((r) => r.errors.length === 0)).toBe(true);
  });
});
