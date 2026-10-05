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
import {
  BLOCK_CONFIRM_TEXT,
  blockDoneText,
  DISPUTE_STATUS_LABELS,
  disputeRows,
  orderUserId,
} from './view.js';

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
      amountText: '$86.00',
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

  it('缺金额 → 占位符（不是 "USD undefined" 也不是 "USD 0"）', () => {
    const [row] = disputeRows([{ ...DISPUTE, dispute_amount: undefined }]);
    expect(row?.amountText).toBe('—');
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

  /**
   * B1 / AJ-193：`withdrawn` 的文案**不能**说成赢了或输了。
   * @why 它是"机构撤回 / 未进入正式拒付"，没有判决。运营照着"已胜诉"会以为钱回来了，
   *      照着"已败诉"会以为钱没了——两种误解都会让他做错后续动作，
   *      而这类错**不会报错**，只会在对账那天变成一笔说不清的差异。
   */
  it('🔴 withdrawn 的文案是"撤回"而不是"胜诉 / 败诉"（它不计输赢）', () => {
    // ⚠️ 只禁"胜诉 / 败诉"两个判决词：文案本身写"不计输赢"是**对的**，
    //    把它一起禁掉反而会让正确的文案过不了（这条断言自己绊倒过一次）。
    const text = DISPUTE_STATUS_LABELS['withdrawn'];
    expect(text).toContain('撤回');
    expect(text).not.toMatch(/胜诉|败诉/);
  });
});

/**
 * 🔴 回归：拉黑是管理端唯一**没有解除入口**的操作（契约只有 block、没有 unblock），
 *    而它**不止"挡住这个人"**——
 *    `app/block-user.ts` 会在同一事务里连带取消该用户名下所有在途单。
 *    L4 浏览器验收（2026-10-02）发现确认面板只说了两条后果、漏了这一条：
 *    运营点下去之后才发现"这个人的未付款订单也没了"。
 *    下面是"三件后果在点之前都得说清"的钉子。
 */
describe('拉黑文案：三件后果在点之前必须全部说清', () => {
  it('🔴 确认文案提到连带取消未付款订单（缺陷注入点：删掉第②条即红）', () => {
    expect(BLOCK_CONFIRM_TEXT).toContain('未付款');
    expect(BLOCK_CONFIRM_TEXT).toContain('取消');
    // 说清是**哪两种**状态会被取消，别让运营去猜"未付款"包不包括支付中
    expect(BLOCK_CONFIRM_TEXT).toContain('待付款');
    expect(BLOCK_CONFIRM_TEXT).toContain('支付中');
  });

  it('🔴 确认文案同时说清"不能下单"与"没有解除入口"（这两条原本就在，别改丢）', () => {
    expect(BLOCK_CONFIRM_TEXT).toContain('40301');
    expect(BLOCK_CONFIRM_TEXT).toContain('没有解除入口');
  });

  it('⚠️ 未付款订单会被取消这件事要写明"库存回补"（运营核对时找得到货）', () => {
    expect(BLOCK_CONFIRM_TEXT).toContain('库存回补');
  });

  it('成功提示同样提到连带取消，并给出核对去处（条数拿不到，不能写死数字）', () => {
    const text = blockDoneText('user-A');
    expect(text).toContain('已拉黑 user-A');
    expect(text).toContain('未付款订单已一并取消');
    expect(text).toContain('订单管理');
    // ❗ 不能出现"已取消 3 单"这类硬编码数字：接口返回空体，前端拿不到条数
    expect(text).not.toMatch(/取消\s*\d+\s*单/);
  });
});
