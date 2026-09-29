/**
 * 职责：`domain/admin-order-actions.ts`（管理端三个操作的准入判定）的单测（I2 U-B2a）。
 *
 * @why 用**十态全遍历**（`ORDER_STATUS` 逐个断言）而不是挑几个状态写用例：
 *      闸门漏一个状态的表现是"那一态的按钮点不动"，既不会报错也不会崩——
 *      只有把十态都断言一遍，加新状态时才会在**这里**红（而不是等客服来报）。
 *      状态枚举来自 shared，与契约 `OrderStatus` 由另一条测试双向比对，不会漂移。
 *
 * @why "拒付 vs 状态"的**判定顺序**各有一条专门用例：两个条件同时满足时，
 *      返回哪个码决定了客服看到的提示是"有拒付"还是"状态不对"——
 *      给错的话客服会去改状态，越改越错（实现里的 @why 写了同一条）。
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS, REFUND_REASON_MAX_LENGTH, type OrderStatus } from '@waselect/shared';
import {
  ADMIN_NOTE_MAX_LENGTH,
  addressGuard,
  clipRefundReason,
  refundGuard,
  refundReasonGuard,
  releaseReasonGuard,
  shipGuard,
} from './admin-order-actions.js';

/** 取失败码；断言"必须通过"前先断言 ok（否则 `code` 是 undefined，断言会假绿）。 */
function codeOf(r: ReturnType<typeof shipGuard>): number {
  if (r.ok) throw new Error('期望被拦，实际放行');
  return r.code;
}

describe('admin-order-actions（管理端操作准入，I2 U-B2a）', () => {
  it('shipGuard：十态里只有 paid 可发货', () => {
    const allowed = ORDER_STATUS.filter((s) => shipGuard(s, false).ok);
    expect(allowed).toEqual(['paid']);
  });

  it('shipGuard：有进行中的拒付 → 40909（不是 40902）', () => {
    const r = shipGuard('paid', true);
    expect(r.ok).toBe(false);
    expect(codeOf(r)).toBe(40909);
  });

  // @why 拒付先于状态判定：这张单**两个理由都能拦**，给 40902 会让客服以为"状态不对"。
  it('shipGuard：拒付与状态同时不合时，报的是拒付（40909）而不是状态（40902）', () => {
    expect(codeOf(shipGuard('cancelled', true))).toBe(40909);
    expect(codeOf(shipGuard('cancelled', false))).toBe(40902);
  });

  it('shipGuard：审核期测试单（is_test）→ 40902 test_order，永不发货（技术文档 §2.9 / AJ-179）', () => {
    const r = shipGuard('paid', false, true);
    expect(codeOf(r)).toBe(40902);
    expect(r.ok ? '' : r.reason).toBe('test_order');
    // 缺省 isTest=false：存量调用口径不变
    expect(shipGuard('paid', false).ok).toBe(true);
  });

  it('refundGuard：paid / shipped / delivered 可退，refunding 可**重试**（KD-4），其余六态拦', () => {
    const allowed = ORDER_STATUS.filter((s) => refundGuard(s, false).ok);
    expect(allowed).toEqual(['paid', 'shipped', 'delivered', 'refunding']);
    // completed 由状态机决定（ORDER_TRANSITIONS.completed = []），本模块不另写一条
    expect(refundGuard('completed', false).ok).toBe(false);
    expect(refundGuard('refunded', false).ok).toBe(false); // 已退完的不能再退
  });

  it('refundGuard：有进行中的拒付 → 40907（D-50）', () => {
    const r = refundGuard('paid', true);
    expect(r.ok).toBe(false);
    expect(codeOf(r)).toBe(40907);
  });

  it('refundGuard：拒付与状态同时不合时，报的是拒付（40907）', () => {
    expect(codeOf(refundGuard('refunding', true))).toBe(40907);
    expect(codeOf(refundGuard('refunded', false))).toBe(40902);
  });

  it('addressGuard：十态里只有 paid 可改址（改完仍是 paid，不是状态迁移）', () => {
    const allowed = ORDER_STATUS.filter((s) => addressGuard(s).ok);
    expect(allowed).toEqual(['paid']);
  });

  // @why 这条守的是"改址**不**因拒付被拦"：同一张单发货被拦、改址放行，
  //      两个闸门对同一个事实给出不同答案是有意为之（改址不动钱也不动货）。
  it('改址不因拒付被拦：同一张单 shipGuard 拦、addressGuard 放行', () => {
    expect(shipGuard('paid', true).ok).toBe(false);
    expect(addressGuard('paid' as OrderStatus).ok).toBe(true);
  });
});

/**
 * 退款理由的长度上限（B7 / AJ-191）。
 *
 * @why 上限这件事最容易被写成"测试里也写一个 500"——那是用第二份常量自证，
 *      改了实现改了测试，两边一起漂。这里的边界值全部由 shared 的常量**算出来**
 *      （`MAX` / `MAX + 1`），常量一动，边界跟着动。
 */
describe('refundReasonGuard：退款理由非空且不超过 500 字（B7 / AJ-191）', () => {
  const MAX = REFUND_REASON_MAX_LENGTH;

  it('恰好 MAX 字 → 通过，且 reason 已 trim（落库的就是它）', () => {
    // 全角空格 U+3000 也要被 trim 掉（写字符串字面量会撞 lint 的 no-irregular-whitespace）
    const pad = '\u3000';
    const raw = `${pad}${'理'.repeat(MAX - 1)}由${pad}`;
    expect(raw.trim().length).toBe(MAX);
    const r = refundReasonGuard(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('期望通过');
    expect(r.reason).toBe('理'.repeat(MAX - 1) + '由');
  });

  it('MAX + 1 字 → 40001 refund_reason_too_long（不是截断后放行）', () => {
    const r = refundReasonGuard('理'.repeat(MAX + 1));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('期望被拦');
    expect(r.code).toBe(40001);
    expect(r.reason).toBe('refund_reason_too_long');
  });

  // @why 不截断：截断后的文本与"运营当时写的意思"可能不是一回事，
  //      而它是要进审计台账的。让他自己删到上限以内，比我们替他删更可解释。
  it('超长一律拒绝，不做"截断后继续"', () => {
    const r = refundReasonGuard('理'.repeat(MAX * 4));
    expect(r.ok).toBe(false);
  });

  it('全角空格 / 纯空白 → refund_reason_required（不是 too_long）', () => {
    for (const bad of ['', '   ', '\u3000\u3000', '\t\n']) {
      const r = refundReasonGuard(bad);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('期望被拦');
      expect(r.reason).toBe('refund_reason_required');
    }
  });

  it('非字符串（缺 / null / 数字 / 对象）→ refund_reason_required', () => {
    for (const bad of [undefined, null, 42, {}, ['缺货']]) {
      const r = refundReasonGuard(bad);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('期望被拦');
      expect(r.reason).toBe('refund_reason_required');
    }
  });
});

/**
 * "人工解除拒付限制"的理由（B1b / AJ-194）。
 *
 * @why 理由**必须**填：这个口能把一张"钱可能已被机构拉回"的订单解锁成可发货、可退款，
 *      是管理端权限最大的动作之一。事后追问"当时为什么解开"一定发生在出事之后——
 *      那时没有理由就没有答案。
 */
describe('releaseReasonGuard：解除理由必填且有上限（B1b / AJ-194）', () => {
  const MAX = ADMIN_NOTE_MAX_LENGTH;

  it('正常理由带出（已 trim）', () => {
    const r = releaseReasonGuard('  机构回调丢失，已核实款项正常  ');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('期望通过');
    expect(r.reason).toBe('机构回调丢失，已核实款项正常');
  });

  it('缺 / 空 / 全角空格 / 非字符串 → release_reason_required', () => {
    for (const bad of [undefined, null, '', '   ', '\u3000', 42, {}]) {
      const r = releaseReasonGuard(bad);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('期望被拦');
      expect(r.reason).toBe('release_reason_required');
    }
  });

  it('超长 → release_reason_too_long（不是截断后放行）', () => {
    expect(releaseReasonGuard('理'.repeat(MAX)).ok).toBe(true);
    const r = releaseReasonGuard('理'.repeat(MAX + 1));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('期望被拦');
    expect(r.reason).toBe('release_reason_too_long');
  });

  // @why 两条失败 reason 必须**不同**：它们进日志与 details，
  //      合成一个词等于把"退款理由太长"与"解除理由太长"两个现场混成一个。
  it('失败 reason 与退款理由的**不重名**（两个现场不能混成一个）', () => {
    const a = releaseReasonGuard(undefined);
    const b = refundReasonGuard(undefined);
    if (a.ok || b.ok) throw new Error('期望都被拦');
    expect(a.reason).not.toBe(b.reason);
  });
});

/**
 * 适配器侧截断（纵深防御，B7 / AJ-191）。
 *
 * @why 只测"确定性"与"不碰已合规文本"两件事：前者是同键同参的前提（KD-4），
 *      后者保证它对新数据**完全不生效**（否则就是在悄悄改运营写的理由）。
 */
describe('clipRefundReason：只截超限的存量脏数据，且必须确定性', () => {
  const MAX = REFUND_REASON_MAX_LENGTH;

  it('未超限 → 一字不动（对新数据完全不生效）', () => {
    for (const s of ['缺货', '', '理'.repeat(MAX)]) {
      expect(clipRefundReason(s)).toBe(s);
    }
  });

  it('超限 → 截到 MAX，且同一输入永远同一输出（重试之间不能变）', () => {
    const long = '理'.repeat(MAX + 300);
    const a = clipRefundReason(long);
    const b = clipRefundReason(long);
    expect(a).toBe(b);
    expect(a.length).toBe(MAX);
    expect(long.startsWith(a)).toBe(true); // 是前缀，不是随便切一段
  });
});
