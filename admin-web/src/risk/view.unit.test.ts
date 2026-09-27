/**
 * 职责：`admin-web/src/risk/view.ts` 的单测。
 *
 * @why 拒付列表的失效形态是**漏看**：进行中的case 排在已结案后面，
 *      运营扫一眼以为"都处理完了"，而举证窗口（Stripe 通常 21 天）就这么过去了。
 *      排序与状态文案是这张表唯一的"轻重提示"。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISPUTE_STATUS_LABELS, disputeRows, orderUserId } from './view.js';

const DISPUTE = {
  order_id: 'o-2609-0013',
  order_no: 'WS-20260927-0013',
  dispute_id: 'dp_1ABC',
  dispute_status: 'open',
  dispute_amount: 8600,
  charge_currency: 'USD',
  opened_at: '2026-09-27T04:05:06Z',
  closed_at: null,
};

describe('disputeRows', () => {
  it('映射出列表行（时间是 JST，金额是原币）', () => {
    const [row] = disputeRows([DISPUTE]);
    expect(row).toMatchObject({
      orderId: 'o-2609-0013',
      orderNo: 'WS-20260927-0013',
      disputeId: 'dp_1ABC',
      status: 'open',
      statusText: '进行中',
      amountText: 'USD 8600',
      openedText: '2026-09-27 13:05',
      closedText: '—',
      urgent: true,
    });
  });

  it('⚠️ 进行中的排最前（已结案的排在前面会被当成"都处理完了"）', () => {
    const rows = disputeRows([
      { ...DISPUTE, dispute_status: 'won' },
      { ...DISPUTE, dispute_id: 'dp_open', dispute_status: 'open' },
      { ...DISPUTE, dispute_status: 'lost' },
    ]);
    expect(rows[0]?.statusText).toBe('进行中');
    expect(rows[0]?.urgent).toBe(true);
  });

  it('⚠️ 未知状态显示"未知状态"而不是空白（空白会被当成"没状态"）', () => {
    const [row] = disputeRows([{ ...DISPUTE, dispute_status: 'inquiry' }]);
    expect(row?.status).toBeNull();
    expect(row?.statusText).toBe('未知状态');
  });

  it('缺金额 → 占位符（不是 "USD undefined"）', () => {
    const [row] = disputeRows([{ ...DISPUTE, dispute_amount: undefined }]);
    expect(row?.amountText).toBe('USD');
    expect(disputeRows([{}])[0]?.amountText).toBe('—');
  });

  it('非数组 → 空列表', () => {
    expect(disputeRows(null)).toEqual([]);
  });
});

describe('orderUserId', () => {
  it('取订单详情里的 user_id', () => {
    expect(orderUserId({ user_id: 'u-9' })).toBe('u-9');
  });

  it('⚠️ 缺 user_id → 空串（拉黑前必须拦住，否则打到 /admin/users//block）', () => {
    expect(orderUserId({})).toBe('');
    expect(orderUserId(null)).toBe('');
  });
});

/** ⚠️ 与契约的双向比对：状态词表的键必须恰好等于 `Dispute.dispute_status` 的 enum。 */
describe('DISPUTE_STATUS_LABELS 与契约的双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../../contracts/api-contract.yaml'), 'utf8');
  const line =
    yaml.split('\n').find((l) => l.includes('dispute_status: {type: string, enum:')) ?? '';

  it('抽到了 dispute_status 的 enum（契约改写成多行会失配）', () => {
    expect(line).toContain('dispute_status');
  });

  it('两边集合相等', () => {
    const bracket = /enum: \[([^\]]+)\]/.exec(line)?.[1] ?? '';
    const contract = bracket
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .sort();
    expect(Object.keys(DISPUTE_STATUS_LABELS).sort()).toEqual(contract);
  });

  it('每条文案非空', () => {
    for (const [k, v] of Object.entries(DISPUTE_STATUS_LABELS)) {
      expect(v, `${k} 的文案为空`).not.toBe('');
    }
  });
});
