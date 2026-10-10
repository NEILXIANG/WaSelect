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
import {
  ORDER_STATUS,
  REFUND_REASON_MAX_LENGTH,
  SHIP_MAX_CHARS,
  type OrderStatus,
} from '@waselect/shared';
import {
  ADMIN_NOTE_MAX_LENGTH,
  addressGuard,
  clipRefundReason,
  refundGuard,
  refundReasonGuard,
  purgeReasonGuard,
  releaseReasonGuard,
  revertShipmentGuard,
  SHIPMENT_REVERT_WINDOW_MS,
  shipGuard,
  shipInfoGuard,
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

  it('refundGuard：迟到付款（late_paid）只放行 expired / cancelled，其余态与无凭据时口径不变（1-5）', () => {
    const allowed = ORDER_STATUS.filter((s) => refundGuard(s, false, true).ok);
    expect(allowed).toEqual(['paid', 'shipped', 'delivered', 'cancelled', 'expired', 'refunding']);
    expect(refundGuard('expired', false, false).ok).toBe(false);
    expect(refundGuard('cancelled', false).ok).toBe(false);
    expect(codeOf(refundGuard('expired', true, true))).toBe(40907); // 拒付仍优先
  });

  it('refundGuard：有进行中的拒付 → 40907（D-50）', () => {
    const r = refundGuard('paid', true);
    expect(r.ok).toBe(false);
    expect(codeOf(r)).toBe(40907);
  });

  it('refundGuard：refunding + 拒付 → 放行（只查询 / 同键重放；换新键那一步由 refund-execution 拦，OPS3-03）', () => {
    expect(refundGuard('refunding', true).ok).toBe(true);
  });

  it('refundGuard：拒付与状态同时不合时，报的是拒付（40907）', () => {
    expect(codeOf(refundGuard('completed', true))).toBe(40907);
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

/**
 * 发货表单的**列宽**校验（AJ-315 / 第二轮审查 B24）。
 *
 * @why 上限由 shared 常量算出，不在测试里再写 32 / 64——写两遍就等于两处都能改、
 *      改一处另一处不红（契约 / 服务端 / 前端各一份正是这条要防的漂移）。
 * @why 边界取"等于上限通过、超 1 拒"：列宽是硬边界（PG 的 VARCHAR(n)），
 *      差一个字符就是 22001，所以这两个值必须都钉住。
 */
describe('shipInfoGuard：必填 + 不超过列宽（AJ-315）', () => {
  const ok = { carrier: 'Japan Post', tracking_no: 'EL123456789JP' };

  it('合规 → 通过，且两个值都 trim 过', () => {
    const r = shipInfoGuard({ carrier: ' Japan Post ', tracking_no: ' EL123 ' });
    if (!r.ok) throw new Error('期望通过');
    expect(r.carrier).toBe('Japan Post');
    expect(r.trackingNo).toBe('EL123');
  });

  it(`承运商等于上限（${String(SHIP_MAX_CHARS.carrier)}）通过，超 1 拒`, () => {
    const at = shipInfoGuard({ ...ok, carrier: 'C'.repeat(SHIP_MAX_CHARS.carrier) });
    expect(at.ok).toBe(true);
    const over = shipInfoGuard({ ...ok, carrier: 'C'.repeat(SHIP_MAX_CHARS.carrier + 1) });
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error('期望被拦');
    expect(over.code).toBe(40001);
    expect(over.reason).toBe('carrier_too_long');
  });

  it(`运单号等于上限（${String(SHIP_MAX_CHARS.tracking_no)}）通过，超 1 拒`, () => {
    const at = shipInfoGuard({ ...ok, tracking_no: 'T'.repeat(SHIP_MAX_CHARS.tracking_no) });
    expect(at.ok).toBe(true);
    const over = shipInfoGuard({ ...ok, tracking_no: 'T'.repeat(SHIP_MAX_CHARS.tracking_no + 1) });
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error('期望被拦');
    expect(over.reason).toBe('tracking_no_too_long');
  });

  /**
   * @why 两个理由必须**分开**：它们进日志，合成一个词等于把"承运商太长"与
   *      "运单号太长"两个现场混成一个，排障时看不出是哪一列撞了列宽。
   */
  it('两个超长理由不同（不是合成一个 ship_fields_invalid）', () => {
    const a = shipInfoGuard({ ...ok, carrier: 'C'.repeat(SHIP_MAX_CHARS.carrier + 1) });
    const b = shipInfoGuard({ ...ok, tracking_no: 'T'.repeat(SHIP_MAX_CHARS.tracking_no + 1) });
    if (a.ok || b.ok) throw new Error('期望都被拦');
    expect(a.reason).not.toBe(b.reason);
  });

  it('缺字段 / 非对象 → 40001 carrier_tracking_no_required（不是抛）', () => {
    for (const bad of [null, undefined, {}, { carrier: 'JP' }, { tracking_no: 'T1' }, 42]) {
      const r = shipInfoGuard(bad);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('期望被拦');
      expect(r.reason).toBe('carrier_tracking_no_required');
    }
  });

  it('全空白 → 必填错而不是"通过"（trim 之后才是判据）', () => {
    const r = shipInfoGuard({ carrier: '   ', tracking_no: '   ' });
    expect(r.ok).toBe(false);
  });

  /**
   * @why 运单号原样落库（AJ-410 / N20a）：运营实际打出 `em 123456789 jp`，这一串进了买家的发货邮件与订单页。
   *      归一放在本函数里——单单发货、批量发货、改运单号三条路径都只经过它，一处改、三处生效。
   */
  it.each([
    ['em 123456789 jp', 'EM123456789JP'],
    [' ee123456789jp ', 'EE123456789JP'],
    ['ej\u3000123456789\u3000jp', 'EJ123456789JP'],
    ['ab\t12-34\ncd', 'AB12-34CD'],
    ['1234-5678-9012', '1234-5678-9012'],
  ] as const)('🔴 运单号归一（去所有空白、转大写、保留连字符）：%j → %s', (raw, expected) => {
    const r = shipInfoGuard({ carrier: 'Japan Post', tracking_no: raw });
    if (!r.ok) throw new Error('期望通过');
    expect(r.trackingNo).toBe(expected);
  });

  it('承运商只 trim、不改大小写（自由文本，"Japan Post" 是写给人看的）', () => {
    const r = shipInfoGuard({ carrier: ' Japan Post ', tracking_no: 'EE123456789JP' });
    if (!r.ok) throw new Error('期望通过');
    expect(r.carrier).toBe('Japan Post');
  });

  it('🔴 长度按**归一之后**量：去掉空白后不超上限的运单号放行（落库的就是归一值）', () => {
    const spaced = 'T '.repeat(SHIP_MAX_CHARS.tracking_no); // 归一后恰好等于上限
    const r = shipInfoGuard({ ...ok, tracking_no: spaced });
    if (!r.ok) throw new Error(`期望通过，实际 ${r.reason}`);
    expect(r.trackingNo).toBe('T'.repeat(SHIP_MAX_CHARS.tracking_no));
  });
});

describe('purgeReasonGuard：删除行为记录的原因必填且有上限（AJ-413）', () => {
  it('非空 → ok 且已 trim；空 / 空白 / 非字符串 → purge_reason_required；超长 → purge_reason_too_long', () => {
    const r = purgeReasonGuard('  买家邮件要求删除  ');
    expect(r).toEqual({ ok: true, reason: '买家邮件要求删除' });
    for (const bad of ['', '   ', 12, null, undefined]) {
      const x = purgeReasonGuard(bad);
      expect(x.ok).toBe(false);
      if (!x.ok) expect(x).toMatchObject({ code: 40001, reason: 'purge_reason_required' });
    }
    expect(purgeReasonGuard('理'.repeat(ADMIN_NOTE_MAX_LENGTH)).ok).toBe(true);
    const long = purgeReasonGuard('理'.repeat(ADMIN_NOTE_MAX_LENGTH + 1));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason).toBe('purge_reason_too_long');
  });
});

/**
 * 撤销发货（严格检查 P0 A-1，AJ-440）：发错单 / 点错单后让订单回到待发货的唯一出口。
 * @why 时间窗边界用表钉死：窗口内可撤、恰好到点不可撤（与关单"到点即过期"同一口径：含等号算超时）。
 */
describe('revertShipmentGuard：只撤 72 小时内、无拒付、无进行中售后的已发货单（AJ-440）', () => {
  const shippedAt = new Date('2026-10-10T00:00:00.000Z');
  const at = (ms: number): Date => new Date(shippedAt.getTime() + ms);
  const base = {
    status: 'shipped' as OrderStatus,
    hasDispute: false,
    afterSaleOpen: false,
    shippedAt,
  };

  it('窗口是 72 小时（文档数字直接进断言）', () => {
    expect(SHIPMENT_REVERT_WINDOW_MS).toBe(72 * 3_600_000);
  });

  it.each([
    ['刚发货', 0, true],
    ['71:59:59.999', SHIPMENT_REVERT_WINDOW_MS - 1, true],
    ['恰好 72 小时', SHIPMENT_REVERT_WINDOW_MS, false],
    ['72 小时零 1 毫秒', SHIPMENT_REVERT_WINDOW_MS + 1, false],
    ['时钟偏差：发货时刻在"未来"', -60_000, true],
  ])('边界：%s → ok=%s', (_n, delta, ok) => {
    const g = revertShipmentGuard({ ...base, now: at(delta) });
    expect(g.ok).toBe(ok);
    if (!g.ok) expect(g).toMatchObject({ code: 40902, reason: 'revert_window_passed' });
  });

  it('十态全遍历：只有 shipped 能撤', () => {
    for (const s of ORDER_STATUS) {
      const g = revertShipmentGuard({ ...base, status: s, now: at(0) });
      if (s === 'shipped') expect(g.ok, s).toBe(true);
      else expect(g, s).toEqual({ ok: false, code: 40902, reason: `status_${s}` });
    }
  });

  it('拒付在途 → 40909（与发货闸门同码）；售后进行中 → 40902 after_sale_open', () => {
    expect(revertShipmentGuard({ ...base, hasDispute: true, now: at(0) })).toEqual({
      ok: false,
      code: 40909,
      reason: 'dispute_open',
    });
    expect(revertShipmentGuard({ ...base, afterSaleOpen: true, now: at(0) })).toEqual({
      ok: false,
      code: 40902,
      reason: 'after_sale_open',
    });
  });

  it('shipped 却没有发货时刻（脏数据）→ 拒，不当成"刚发货"放行', () => {
    expect(revertShipmentGuard({ ...base, shippedAt: null, now: at(0) })).toEqual({
      ok: false,
      code: 40902,
      reason: 'shipped_at_missing',
    });
  });
});
