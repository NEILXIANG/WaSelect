/**
 * 职责：客户页纯函数（AJ-404）——列表行文案、短 id、风险文案、地址一行、列表查询串。
 *
 * @why 金额 / 时间都走 `format.ts`（円千分位、JST），这里只断言"拼出来的那一行"——
 *      口径错（例如把未付单算进累计）是服务端的事，前端只负责不把缺失显示成 0。
 */
import { describe, expect, it } from 'vitest';
import {
  addressLine,
  customerListQuery,
  customerRows,
  riskText,
  shortId,
  statsCards,
} from './view.js';

describe('shortId（列表里的"打码标识"：只露前 8 位，完整 id 在详情页可复制）', () => {
  it('u-<uuid> → u-前 8 位…', () => {
    expect(shortId('u-3f6c2a9e-1b7d-4e8a-9c0f-5d2e7a1b4c6d')).toBe('u-3f6c2a9e…');
  });
  it('本来就短的 id 原样（截了反而认不出）', () => {
    expect(shortId('u-cust-a')).toBe('u-cust-a');
  });
});

describe('customerRows', () => {
  it('完整行：收件人 / 邮箱 / 单数 / 累计 / 最近下单（JST）/ 拉黑', () => {
    expect(
      customerRows([
        {
          id: 'u-cust-a',
          created_at: '2026-08-20T03:00:00.000Z',
          blocked: false,
          order_count: 3,
          paid_order_count: 2,
          paid_total_jpy: 21380,
          last_order_at: '2026-10-01T01:00:00.000Z',
          contact_email: 'zhang.wei@example.com',
          last_recipient: 'Zhang Wei',
        },
      ]),
    ).toEqual([
      {
        id: 'u-cust-a',
        idText: 'u-cust-a',
        name: 'Zhang Wei',
        email: 'zhang.wei@example.com',
        ordersText: '3 单 · 已付 2',
        paidTotalText: '21,380 円',
        lastOrderText: '2026-10-01 10:00',
        blocked: false,
      },
    ]);
  });

  it('没下过单：名字与邮箱显示占位，累计 0 円（服务端给的就是 0），最近下单 —', () => {
    const [r] = customerRows([
      {
        id: 'u-cust-c',
        created_at: '2026-09-30T03:00:00.000Z',
        blocked: true,
        blocked_at: '2026-10-01T00:00:00.000Z',
        order_count: 0,
        paid_order_count: 0,
        paid_total_jpy: 0,
      },
    ]);
    expect(r).toMatchObject({
      name: '（未下单）',
      email: '—',
      ordersText: '0 单',
      paidTotalText: '0 円',
      lastOrderText: '—',
      blocked: true,
    });
  });
});

describe('riskText', () => {
  it('已拉黑 + 有进行中的拒付', () => {
    expect(
      riskText({
        blocked: true,
        blocked_at: '2026-09-28T05:00:00.000Z',
        risk: { dispute_count: 2, open_dispute_count: 1 },
      }),
    ).toEqual({ text: '已拉黑（2026-09-28 14:00）· 拒付 2 笔，进行中 1 笔', danger: true });
  });
  it('正常客户：无拒付', () => {
    expect(riskText({ blocked: false, risk: { dispute_count: 0, open_dispute_count: 0 } })).toEqual(
      { text: '未拉黑 · 无拒付记录', danger: false },
    );
  });
  it('拒付都已结案：不标红', () => {
    expect(riskText({ blocked: false, risk: { dispute_count: 1, open_dispute_count: 0 } })).toEqual(
      { text: '未拉黑 · 拒付 1 笔，均已结案', danger: false },
    );
  });
});

describe('statsCards', () => {
  it('没有下单时间：日期卡大字 "—"、不出现时刻小字', () => {
    const cards = statsCards({ order_count: 0, paid_order_count: 0, paid_total_jpy: 0 } as never);
    expect(cards.filter((c) => c.label === '首单' || c.label === '最近下单')).toEqual([
      { label: '首单', value: '—', sub: '' },
      { label: '最近下单', value: '—', sub: '' },
    ]);
  });

  it('四张卡：订单数 / 累计实付 / 首单 / 最近下单；测试单单列一句', () => {
    expect(
      statsCards({
        order_count: 3,
        paid_order_count: 2,
        paid_total_jpy: 21380,
        test_order_count: 1,
        first_order_at: '2026-09-01T02:00:00.000Z',
        last_order_at: '2026-10-01T01:00:00.000Z',
      }),
    ).toEqual([
      { label: '订单数', value: '3 单', sub: '已付款 2 单（另有测试单 1 张，不计入）' },
      { label: '累计实付', value: '21,380 円', sub: '已付款订单合计，不扣退款' },
      // 2026-10-09 浏览器验收：大字只放日期（整串大字会折两行），时刻放小字
      { label: '首单', value: '2026-09-01', sub: '11:00（日本时间）' },
      { label: '最近下单', value: '2026-10-01', sub: '10:00（日本时间）' },
    ]);
  });
});

describe('addressLine', () => {
  it('街道 + 二行 + 城市 州 邮编 + 国家；电话另列', () => {
    expect(
      addressLine({
        recipient: 'Li Na',
        phone: '+12135550178',
        line1: '1234 Wilshire Blvd Unit 305',
        line2: 'Floor 3',
        city: 'Los Angeles',
        state: 'CA',
        postal_code: '90017',
        country: 'US',
      }),
    ).toBe('1234 Wilshire Blvd Unit 305, Floor 3, Los Angeles CA 90017, US');
  });
  it('没有二行就不留空逗号', () => {
    expect(
      addressLine({
        line1: '350 5th Ave Apt 12B',
        city: 'New York',
        state: 'NY',
        postal_code: '10118',
        country: 'US',
      }),
    ).toBe('350 5th Ave Apt 12B, New York NY 10118, US');
  });
});

describe('customerListQuery', () => {
  it('关键字去空白、空串不带；第 1 页不带 page', () => {
    expect(customerListQuery({ keyword: '  zhang ', page: 1 })).toBe('?keyword=zhang');
    expect(customerListQuery({ keyword: '', page: 3 })).toBe('?page=3');
    expect(customerListQuery({ keyword: ' ', page: 1 })).toBe('');
  });
  it('邮箱里的 @ / + 被编码（不让 + 在服务端变成空格）', () => {
    expect(customerListQuery({ keyword: 'a+b@example.com', page: 1 })).toBe(
      '?keyword=a%2Bb%40example.com',
    );
  });
});
