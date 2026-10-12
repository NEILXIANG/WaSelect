/**
 * 职责：订单状态文案（共享层）的单测。
 *
 * @why 这组断言是从 `pages/order/index.vm.unit.test.ts` **连测试一起搬过来的**（§2 第 50 条同族：
 *      只搬代码不搬测试 = 原模块守护静默消失）。钉的是两件**都不报错**的事：
 *      ① 状态词表与契约 enum 漂移 → 新增状态后前端静默显示"状态未知"；
 *      ② 能付的状态与可取消的状态不一致 → "能付但取消不了"的半开状态。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '@waselect/shared';
import {
  TIMELINE_LABELS,
  timelineText,
  BUYER_STATUS,
  PAYABLE,
  STATUS_LABELS,
  STOCK_REFUND_NOTE,
  buyerStatus,
  canPay,
  statusText,
} from './order-status.js';

describe('statusText（状态文案）', () => {
  it('词表内 → 中文', () => {
    expect(statusText('created')).toBe('待付款');
    expect(statusText('refunded')).toBe('已退款');
  });

  it('⚠️ 不在词表 / 脏输入 → "状态未知"（不是空串：空白标签和渲染错无法区分）', () => {
    expect(statusText('brand_new')).toBe('状态未知');
    expect(statusText('')).toBe('状态未知');
    expect(statusText(null)).toBe('状态未知');
    expect(statusText(123)).toBe('状态未知');
  });
});

describe('canPay（能否继续支付）', () => {
  it('⚠️ 只有 created / pending_payment（与可取消态一致）', () => {
    expect(PAYABLE).toEqual(['created', 'pending_payment']);
    expect(canPay('created')).toBe(true);
    expect(canPay('pending_payment')).toBe(true);
    for (const s of [
      'paid',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'expired',
      'refunding',
      'refunded',
    ]) {
      expect(canPay(s), `${s} 不该可付`).toBe(false);
    }
    expect(canPay(null)).toBe(false);
  });
});

/**
 * ⚠️ 与契约的双向比对：词表的键必须**恰好等于** `OrderStatus` 的 enum。
 * @why 服务端新增一个状态而前端没跟进的表现是：订单上这一列显示"状态未知"——
 *      不报错、不崩溃，只是用户看不懂自己的订单怎么了。
 */
describe('STATUS_LABELS 与契约 OrderStatus 的双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../contracts/api-contract.yaml'), 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('OrderStatus: {')) ?? '';
  const enumLine = line.slice(line.indexOf('enum:'));
  const contractStatuses = (enumLine.match(/[a-z_]+/g) ?? []).filter((w) => w !== 'enum');

  it('抽到了 OrderStatus 的 enum（契约改写成多行会失配）', () => {
    expect(line).toContain('OrderStatus');
    expect(contractStatuses.length).toBeGreaterThan(0);
  });

  it('两边集合相等：契约有而词表没有 → 静默显示"状态未知"', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...contractStatuses].sort());
  });

  it('每条文案都非空（空串 = 真机上一个空白标签）', () => {
    for (const [status, label] of Object.entries(STATUS_LABELS)) {
      expect(label, `${status} 的文案为空`).not.toBe('');
    }
  });
});

/**
 * M-06（AJ-405 / AJ-402 Q4）：买家视角的当前状态文案 + "下一步会发生什么"。
 * @why 代购的付款—发货空档有好几天，系统态直译"已付款"挂着不动会被读成卡住；
 *      这组断言钉住三件**错了不报错**的事：漏一个状态（静默落"状态未知"）、
 *      文案里冒出未实测的时效数字、与退款 / 缺货口径说法不一致。
 */
describe('buyerStatus（买家视角状态与下一步，M-06）', () => {
  it('🔴 词表覆盖 shared ORDER_STATUS 全部状态，且与 STATUS_LABELS 同一集合（契约比对见上）', () => {
    expect(Object.keys(BUYER_STATUS).sort()).toEqual([...ORDER_STATUS].sort());
    expect(Object.keys(BUYER_STATUS).sort()).toEqual(Object.keys(STATUS_LABELS).sort());
  });

  it('每个状态的 title 与 next 都非空（空串 = 真机上空白一行）', () => {
    for (const s of ORDER_STATUS) {
      const b = buyerStatus(s);
      expect(b.title, s).not.toBe('');
      expect(b.next, s).not.toBe('');
    }
  });

  it('代购视角的三个关键态', () => {
    expect(buyerStatus('paid').title).toBe('已付款 · 日本采购中');
    expect(buyerStatus('shipped').title).toBe('已发货 · 国际运输中');
    expect(buyerStatus('delivered').title).toBe('已送达');
    expect(buyerStatus('created').title).toBe('待付款');
  });

  it('🔴 已付款：留了邮箱才说"会发邮件"；没留 / 不知道（列表无此字段）→ 只说"在订单详情查看"', () => {
    expect(buyerStatus('paid', { email: true }).next).toContain('邮件');
    expect(buyerStatus('paid', { email: false }).next).not.toContain('邮件');
    expect(buyerStatus('paid').next).not.toContain('邮件');
    expect(buyerStatus('paid', { email: false }).next).toContain('运单号');
  });

  // 统一结论 5.3：同一句"下一步"在详情页与列表各出现一次——详情页说"去订单详情"是自指；
  // 列表行没有复制运单号、确认收货、申请售后这些按钮，照搬详情页的话就是让人去找不存在的东西
  it('🔴 详情页口径（默认）：**任何状态**都不说"在订单详情里…"（人已经在详情页）', () => {
    for (const s of ORDER_STATUS) {
      expect(buyerStatus(s).next, s).not.toContain('订单详情');
      expect(buyerStatus(s, { email: true }).next, s).not.toContain('订单详情');
    }
    for (const s of ['delivered', 'completed'])
      expect(buyerStatus(s).next, s).toContain('申请售后');
  });

  it('🔴 列表口径（inList）：要在详情页做的事都指向订单详情，不叫人在列表里复制运单号 / 点确认收货', () => {
    const shipped = buyerStatus('shipped', { inList: true }).next;
    expect(shipped).not.toContain('复制');
    expect(shipped).not.toContain('「确认收货」');
    expect(shipped).toContain('订单详情');
    for (const s of ['delivered', 'completed']) {
      expect(buyerStatus(s, { inList: true }).next, s).toContain('订单详情');
    }
    // 没有列表专用文案的状态：与详情页同一句
    expect(buyerStatus('refunded', { inList: true }).next).toBe(buyerStatus('refunded').next);
  });

  it('🔴 已发货：给出"确认收货 / 到期自动确认"的去处（AJ-387）；天数是服务端配置 AUTO_DELIVER_DAYS，不写死', () => {
    const n = buyerStatus('shipped').next;
    expect(n).toContain('确认收货');
    expect(n).toContain('自动');
    expect(n).not.toMatch(/[0-9]/);
  });

  it('🔴 退款两态的到账时间与缺货退款说明同口径（5–10 个工作日）', () => {
    expect(STOCK_REFUND_NOTE).toContain('5–10 个工作日');
    expect(buyerStatus('refunding').next).toContain('5–10 个工作日');
    expect(buyerStatus('refunded').next).toContain('5–10 个工作日');
  });

  it('🔴 不写未实测的送达时效（AJ-402 Q2）', () => {
    for (const s of ORDER_STATUS) {
      for (const w of ['天内送达', '天送达', '日达', '预计送达']) {
        expect(buyerStatus(s, { email: true }).next, `${s}:${w}`).not.toContain(w);
      }
    }
  });

  it('⚠️ 不在词表 / 脏输入 → "状态未知" + 指向客服（不是空白）', () => {
    for (const bad of ['brand_new', '', null, 42, undefined]) {
      expect(buyerStatus(bad)).toEqual({
        title: '状态未知',
        next: '如有疑问，请联系客服并提供订单号',
      });
    }
  });

  it('opts 脏值（null / 字符串）按"不知道有没有邮箱"处理，不抛', () => {
    expect(buyerStatus('paid', null as unknown as undefined).next).not.toContain('邮件');
    expect(buyerStatus('paid', 'x' as unknown as undefined).next).not.toContain('邮件');
  });
});

// 全入口点击测试 2026-10-11：订单详情的时间线原用状态词（待付款 / 付款中 / 已付款）——
// 时间线讲"那时发生了什么"，主流写事件（提交订单 / 付款成功 / 商家已发货）
describe('TIMELINE_LABELS（时间线事件词）', () => {
  it('🔴 覆盖全部十态（与 STATUS_LABELS 同一集合）；每条非空', () => {
    expect(Object.keys(TIMELINE_LABELS).sort()).toEqual(Object.keys(STATUS_LABELS).sort());
    for (const v of Object.values(TIMELINE_LABELS)) expect(v).not.toBe('');
  });

  it('🔴 事件词：created → 提交订单、paid → 付款成功；不认识的 → 状态未知', () => {
    expect(timelineText('created')).toBe('提交订单');
    expect(timelineText('paid')).toBe('付款成功');
    expect(timelineText('nope')).toBe('状态未知');
  });
});
