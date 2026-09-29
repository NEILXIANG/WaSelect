/**
 * 职责：确认订单页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的全是**点了之后看起来成功、实际是坏的**：
 *      ① 建单不带 expected_total_jpy → 失去"看到的 ≠ 算出来的"这道防线（40905）；
 *      ② 商品行带价格 → 有人会拿它当合计（cart-store @limitation 一 的红线）；
 *      ③ 提交闸门禁用却不说原因 → 被读成"这站坏了"。
 *      （幂等键已下沉到 `utils/idem-key.js`，由 `idem-key.unit.test.ts` 覆盖。）
 *
 * @why 支付相关（通道渲染 / 下一步做什么）**不在这里**——它们住在
 *      `utils/pay-plan.js` 并由 `pay-plan.unit.test.ts` 覆盖：确认页与支付页共用同一份，
 *      拆开测会让"两页显示不一致"这件事没有守卫。
 */
import { describe, expect, it } from 'vitest';
import { contactEmailOf, itemRows, orderBody, submitGate } from './index.vm.js';

const ITEMS = [
  { productId: 'p-shiro-cleansing-oil', qty: 2, title: '資生堂 クレンジングオイル 200ml' },
  { productId: 'p-knife-210mm', qty: 1, title: '堺孝行 柳刃包丁 210mm' },
];

describe('itemRows（商品行）', () => {
  it('只给标题与数量——⚠️ **没有价格字段**', () => {
    const [row] = itemRows(ITEMS);
    expect(row).toEqual({
      productId: 'p-shiro-cleansing-oil',
      qty: 2,
      title: '資生堂 クレンジングオイル 200ml',
    });
    // 价格一旦出现在这里，就会有人拿它算合计——而快照价会过期
    expect(Object.keys(row ?? {})).not.toContain('priceJpy');
    expect(Object.keys(row ?? {})).not.toContain('priceText');
  });

  it('脏输入：非数组 → 空；没 productId 的行丢掉；qty 非整数归一成 1', () => {
    expect(itemRows(null)).toEqual([]);
    expect(itemRows([{ title: 'x' }, ...ITEMS])).toHaveLength(2);
    expect(itemRows([{ productId: 'p-1', qty: '3' }])[0]?.qty).toBe(1);
  });
});

describe('submitGate（提交闸门）', () => {
  const OK = { itemCount: 2, addressId: 'addr-1', termsAccepted: true, totalJpy: 9150 };

  it('四项齐全 → 可提交', () => {
    expect(submitGate(OK)).toEqual({ ok: true, reason: '' });
  });

  it('⚠️ 每一项缺失都给**具体原因**（禁用按钮不说为什么会被读成"这站坏了"）', () => {
    expect(submitGate({ ...OK, itemCount: 0 }).reason).toBe('购物车是空的');
    expect(submitGate({ ...OK, addressId: '' }).reason).toBe('请选择收货地址');
    expect(submitGate({ ...OK, termsAccepted: false }).reason).toBe('请先阅读并同意购买条款');
    expect(submitGate({ ...OK, totalJpy: null }).reason).toBe('运费与合计还在计算中');
  });

  it('脏输入：null → 不可提交，不抛', () => {
    expect(submitGate(null as never).ok).toBe(false);
  });
});

describe('orderBody（建单请求体）', () => {
  const ARGS = {
    items: ITEMS,
    addressId: 'addr-1',
    termsVersion: 'TOS-2026-09-20',
    expectedTotalJpy: 9150,
  };

  it('完整：items（契约形状）+ address_id + terms_version + expected_total_jpy', () => {
    expect(orderBody(ARGS)).toEqual({
      items: [
        { product_id: 'p-shiro-cleansing-oil', qty: 2 },
        { product_id: 'p-knife-210mm', qty: 1 },
      ],
      address_id: 'addr-1',
      terms_version: 'TOS-2026-09-20',
      expected_total_jpy: 9150,
    });
  });

  it('⚠️ 缺 terms_version / address_id → **抛**（晚失败只会转一圈然后被拒单）', () => {
    expect(() => orderBody({ ...ARGS, termsVersion: '' })).toThrow(/terms_version/);
    expect(() => orderBody({ ...ARGS, addressId: '' })).toThrow(/address_id/);
  });

  it('⚠️ total 还没算出来 → **不带** expected_total_jpy（带 null 会被类型校验拒）', () => {
    const body = orderBody({ ...ARGS, expectedTotalJpy: null });
    expect(Object.keys(body)).not.toContain('expected_total_jpy');
  });

  it('联系邮箱：给了才带，空串不带', () => {
    // ⚠️ 用 toMatchObject 而不是点属性：body 的静态类型里没有可选键，
    //    而"带了没有"正是本用例要验的事（点属性会被类型系统替我们回答）
    expect(orderBody({ ...ARGS, contactEmail: 'a@b.com' })).toMatchObject({
      contact_email: 'a@b.com',
    });
    expect(Object.keys(orderBody({ ...ARGS, contactEmail: '' }))).not.toContain('contact_email');
  });
});

/**
 * 可选收货通知邮箱（PRD §3 确认订单 / D-39；提审前必须，AJ-180）。
 * @why 选填：空着照常下单；填了就必须是服务端会收的形状——否则"提交 → 40001"
 *      给出的是泛化的"参数错误"，用户不知道错在邮箱。口径与服务端入口一致（有 @、无空白、≤255）。
 */
describe('contactEmailOf（选填邮箱）', () => {
  it('空 / 纯空白 → 不带（value 为空串）、不拦', () => {
    expect(contactEmailOf('')).toEqual({ value: '', error: '' });
    expect(contactEmailOf('   ')).toEqual({ value: '', error: '' });
    expect(contactEmailOf(undefined)).toEqual({ value: '', error: '' });
  });

  it('去首尾空白后合法 → 带上', () => {
    expect(contactEmailOf('  jane@example.com ')).toEqual({ value: 'jane@example.com', error: '' });
  });

  it('形状不对 / 中间有空白 / 超过 255 → 给具体原因（与服务端 contact_email_shape 同口径）', () => {
    for (const bad of [
      'jane',
      'jane@',
      '@example.com',
      'ja ne@example.com',
      `${'a'.repeat(250)}@x.com`,
    ]) {
      expect(contactEmailOf(bad).error, bad).toBe('邮箱格式不正确（可留空）');
    }
  });

  it('submitGate：邮箱有错 → 不可提交且原因指向邮箱；其余四项的原因优先', () => {
    const OK = { itemCount: 2, addressId: 'addr-1', termsAccepted: true, totalJpy: 9150 };
    expect(submitGate({ ...OK, emailError: '邮箱格式不正确（可留空）' })).toEqual({
      ok: false,
      reason: '邮箱格式不正确（可留空）',
    });
    expect(submitGate({ ...OK, itemCount: 0, emailError: 'x' }).reason).toBe('购物车是空的');
    expect(submitGate({ ...OK, emailError: '' }).ok).toBe(true);
  });
});
