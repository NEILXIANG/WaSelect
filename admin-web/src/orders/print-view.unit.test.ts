/**
 * 职责：打印视图模型（AJ-407）——只收 paid、字段缺失显眼、申报合计按美分相加、电话排版。
 * @see ./print-view.ts
 */
import { describe, expect, it } from 'vitest';
import { PURCHASE_UNRECORDED } from './view.js';
import { phoneText, printModel } from './print-view.js';

const PAID = {
  order_id: 'ord_a',
  order_no: '261007-7K3QXA',
  status: 'paid',
  address: {
    recipient: 'Jane Doe',
    phone: '+14155550123',
    line1: '1 Infinite Loop',
    line2: 'Apt 4',
    city: 'Cupertino',
    state: 'CA',
    postal_code: '95014',
    country: 'US',
  },
  items: [
    {
      title: 'Deba Knife 出刃包丁',
      qty: 1,
      title_ja: '出刃包丁 165mm',
      jan_code: '4900000000011',
      purchase_source: '堺 刃物店',
      hs_code: '8211.91',
      customs_desc_en: 'Kitchen knife, stainless',
      declared_value_usd: 8576,
      weight_g: 540,
    },
    // 历史行：无快照（迁移 021 / 027 之前）
    { title: '茶碗', qty: 2, declared_value_usd: 1, weight_g: 300 },
  ],
};

describe('printModel（AJ-407）', () => {
  it('paid 单：拣货行 + 面单信息；缺失字段写「未记录」；申报合计按美分相加', () => {
    const m = printModel([PAID]);
    expect(m.skipped).toEqual([]);
    const [o] = m.orders;
    expect(o?.orderNo).toBe('261007-7K3QXA');
    expect(o?.pick[0]).toEqual({
      title: 'Deba Knife 出刃包丁',
      titleJa: '出刃包丁 165mm',
      jan: '4900000000011',
      source: '堺 刃物店',
      qty: 1,
    });
    expect(o?.pick[1]?.jan).toBe(PURCHASE_UNRECORDED);
    expect(o?.addressLines).toEqual(['1 Infinite Loop', 'Apt 4', 'Cupertino, CA 95014', 'US']);
    expect(o?.phone).toBe('+1 (415) 555-0123');
    expect(o?.declared[0]).toMatchObject({
      desc: 'Kitchen knife, stainless',
      hs: '8211.91',
      valueText: '$85.76',
      weightText: '540 g',
    });
    expect(o?.declared[1]?.hs).toBe(PURCHASE_UNRECORDED);
    expect(o?.declaredTotalText).toBe('$85.77');
  });

  it('非 paid 的单列入 skipped（不静默丢）；缺申报价 → 合计显示 —（不拿缺的当 0）', () => {
    const m = printModel([
      { order_id: 'ord_s', order_no: '261001-AAAAAA', status: 'shipped' },
      { ...PAID, items: [{ title: 'x', qty: 1 }] },
    ]);
    expect(m.skipped).toEqual(['261001-AAAAAA']);
    expect(m.orders[0]?.declaredTotalText).toBe('—');
  });

  it('phoneText：只排 +1 十位；其它原样；空 → —', () => {
    expect(phoneText('+14155550123')).toBe('+1 (415) 555-0123');
    expect(phoneText('+81312345678')).toBe('+81312345678');
    expect(phoneText('')).toBe('—');
  });
});

describe('拣货单只打能发货的单（审查 2026-10-09 #5）', () => {
  it('🔴 paid 但拒付中 / 测试单 → 列入 skipped，不出拣货行', () => {
    const m = printModel([
      { ...PAID, has_dispute: true },
      { ...PAID, order_no: '261007-TEST01', is_test: true },
      PAID,
    ]);
    expect(m.orders.map((o) => o.orderNo)).toEqual([PAID.order_no]);
    expect(m.skipped).toEqual([PAID.order_no, '261007-TEST01']);
  });
});
