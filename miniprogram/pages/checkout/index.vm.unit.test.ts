/**
 * 职责：确认订单页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的全是**点了之后看起来成功、实际是坏的**：
 *      ① 建单不带 expected_total_jpy → 失去"看到的 ≠ 算出来的"这道防线（40905）；
 *      ② 商品行带价格 → 有人会拿它当合计（cart-store @limitation 一 的红线）；
 *      ③ 提交闸门禁用却不说原因 → 被读成"这站坏了"。
 *      （幂等键已下沉到 `utils/idempotency.js`，由 `idempotency.unit.test.ts` 覆盖。）
 *
 * @why 支付相关（通道渲染 / 下一步做什么）**不在这里**——它们住在
 *      `utils/pay-plan.js` 并由 `pay-plan.unit.test.ts` 覆盖：确认页与支付页共用同一份，
 *      拆开测会让"两页显示不一致"这件事没有守卫。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  contactEmailOf,
  itemRows,
  keyAction,
  orderBody,
  recoveryFor,
  resolveAddressId,
  submitGate,
} from './index.vm.js';

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

  it('⚠️ 超过单笔上限（splitRequired）→ 不放行（B38 / AJ-221）', () => {
    // @why 服务端 splitHint = total > maxOrderJpy，**已经超了**，提交必然 40906。
    //      以前它只是一句提示、闸门照样放行：用户点了才知道被拒，
    //      而这个失败看起来像"系统出问题"，不像"我这单太大"。
    const g = submitGate({ ...OK, splitRequired: true });
    expect(g.ok).toBe(false);
    expect(g.reason).toBe('已超过单笔上限，请分两单下单');
    // 反向：不超时照常放行（这条是"只在该拦的时候拦"的另一半）
    expect(submitGate({ ...OK, splitRequired: false }).ok).toBe(true);
    expect(submitGate(OK).ok).toBe(true);
  });

  it('splitRequired 排在"合计还在计算中"之后——没有合计时先说合计，不说拆单', () => {
    // @why 两件事都发生时，用户要先知道"钱还没算出来"；
    //      一上来就说"请分两单"会让人以为金额已经定了。
    expect(submitGate({ ...OK, totalJpy: null, splitRequired: true }).reason).toBe(
      '运费与合计还在计算中',
    );
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
 * 可选联系邮箱（PRD §3 确认订单 / D-39；提审前必须，AJ-180）。
 * ⚠️ AJ-295：原名"收货通知邮箱"——通知链路无使用方，改名以匹配真实用途。
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

/**
 * 地址预选（全量审查 A6，2026-09-29）：每次 `onShow` 都会重算一次地址，
 * 而"用户刚从地址页选的那一个"是一次性的（读走即清空）。
 * @why 这三个用例钉的是**同一个缺陷的三个面**：少了"当前已选"这一段优先级，
 *      用户只要离开结算页再回来（看条款 / 切后台 / 进地址页没选就返回），
 *      地址就静默回到默认地址并按它发货——页面显示的确实是默认地址，用户不会再核对。
 */
describe('resolveAddressId（地址预选的三段优先级）', () => {
  const LIST = [{ id: 'addr-A', isDefault: true }, { id: 'addr-B' }];

  it('一次性选择优先（刚从地址页选完回来）', () => {
    expect(
      resolveAddressId({ picked: 'addr-B', current: 'addr-A', list: LIST, fallback: 'addr-A' }),
    ).toBe('addr-B');
  });

  it('🔴 没有一次性选择时**保留当前已选**（看完条款返回 / 切后台回来，A6 的原缺陷）', () => {
    expect(
      resolveAddressId({ picked: '', current: 'addr-B', list: LIST, fallback: 'addr-A' }),
    ).toBe('addr-B');
  });

  it('当前地址已被删除（不在列表里）→ 回落默认，而不是带着一个不存在的 id 去建单', () => {
    expect(
      resolveAddressId({ picked: '', current: 'addr-deleted', list: LIST, fallback: 'addr-A' }),
    ).toBe('addr-A');
  });

  it('列表为空 → 空串（让 submitGate 报"请选择收货地址"）', () => {
    expect(resolveAddressId({ picked: '', current: 'addr-B', list: [], fallback: '' })).toBe('');
    expect(resolveAddressId({})).toBe('');
  });
});

describe('keyAction：幂等键跟着请求体走（AJ-228）', () => {
  it('从没发过（sentBody 为 null）→ reuse（acquire 自己会给新键）', () => {
    expect(keyAction({ sentBody: null, body: '{"a":1}' })).toBe('reuse');
  });
  it('与上一次带出去的请求体逐字相同 → reuse（超时后原样重试必须是同一个键）', () => {
    expect(keyAction({ sentBody: '{"a":1}', body: '{"a":1}' })).toBe('reuse');
  });
  it('🔴 请求体变了 → renew（同键不同内容是 40908 死路）', () => {
    expect(keyAction({ sentBody: '{"a":1}', body: '{"a":2}' })).toBe('renew');
  });
  it('脏输入不抛，按"没发过"处理', () => {
    expect(keyAction(null)).toBe('reuse');
    expect(keyAction({})).toBe('reuse');
  });
});

describe('submitGate：条款与报价的失败态（AJ-228）', () => {
  const OK = { itemCount: 1, addressId: 'a-1', termsAccepted: true, totalJpy: 9150 };
  it('不传这三项 = 不检查（老调用方不受影响）', () => {
    expect(submitGate(OK)).toEqual({ ok: true, reason: '' });
  });
  it('🔴 条款取失败 → 拦，且原因说的是条款（不是"请先同意"）', () => {
    const g = submitGate({ ...OK, termsReady: false, termsFailed: true });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('条款');
    expect(g.reason).not.toContain('同意');
  });
  it('条款还在加载 → 拦，说"正在加载"', () => {
    expect(submitGate({ ...OK, termsReady: false }).reason).toContain('正在加载');
  });
  it('🔴 报价失败 → 说"报价失败 / 购物车"，不说"计算中"（失败了就不会再有结果）', () => {
    const g = submitGate({ ...OK, totalJpy: null, quoteFailed: true });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('购物车');
    expect(g.reason).not.toContain('计算中');
  });
  it('报价还没回来（没失败）→ 仍说"计算中"', () => {
    expect(submitGate({ ...OK, totalJpy: null, quoteFailed: false }).reason).toContain('计算中');
  });
});

describe('recoveryFor：建单失败之后页面该做什么（B37 / AJ-220）', () => {
  it('40905（管理员改价）/ 40901（库存不足）/ 40401（商品下架）→ 重新报价', () => {
    // @why 这三个码的共同点是"**页面上的数已经不是真的了**"：
    //      不重报价的话，再点一次仍带旧的 expected_total_jpy，于是还是同一个码——
    //      用户只能退出重进，而这个死循环没有任何报错。
    expect(recoveryFor(40905)).toBe('requote');
    expect(recoveryFor(40901)).toBe('requote');
    expect(recoveryFor(40401)).toBe('requote');
  });

  it('40011（条款版本不一致）→ 重拉条款', () => {
    expect(recoveryFor(40011)).toBe('reload_terms');
  });

  it('反向：这些码**不该**触发自动恢复（自动做了反而更糟）', () => {
    // 40902 状态不允许：重报价救不了它，只会多打一次请求
    expect(recoveryFor(40902)).toBe('none');
    // 42901 限流：立刻重报价 = 自己再撞一次限流
    expect(recoveryFor(42901)).toBe('none');
    // 40101 未登录：由请求层静默重登录，不该在页面层重报价
    expect(recoveryFor(40101)).toBe('none');
  });

  it('40908（同键不同内容）→ 作废键（AJ-228：否则这一页每次再点都是同一个码）', () => {
    expect(recoveryFor(40908)).toBe('renew_key');
  });

  /**
   * MP3-09：40913（在途单已达上限）的 action 是"引导去订单列表支付或取消已有订单"。
   * 只显示文案的话，用户要自己 回首页 → 我的 → 我的订单 → 逐张进详情取消——
   * 大多数人做不到，结果是放弃这一单。
   */
  it('🔴 40913（在途单太多）→ 去订单列表（文案说了要去处理，就得给去处）', () => {
    expect(recoveryFor(40913)).toBe('go_orders');
  });

  it('脏输入（undefined / 字符串 / 0）→ none，不抛', () => {
    for (const c of [undefined, null, '40905', 0, 40905.5]) {
      expect(recoveryFor(c), String(c)).toBe('none');
    }
  });

  it('每个"要恢复"的码都能在错误码登记表里找到对应的 action（登记表不是死数据）', () => {
    // @why 这份清单的价值全在于它与服务端登记表同源；哪天服务端删掉或改了某个码的处置，
    //      这条必须红，而不是让前端接着执行一个没人认的指令。
    const reg = readFileSync(
      new URL('../../../packages/shared/src/errors.ts', import.meta.url),
      'utf8',
    );
    expect(reg.length, '自检：登记表读到了内容').toBeGreaterThan(0);
    // ⚠️ 40913 一并纳入：`go_orders` 的来源是登记表里那条"引导去订单列表"的 action
    for (const c of [40905, 40901, 40401, 40011, 40913]) {
      expect(reg, `${c} 必须在登记表中`).toContain(`${c}:`);
    }
    expect(reg).toContain(
      "40905: { code: 40905, message: '价格已变动', action: '提示刷新确认页' }",
    );
  });
});

/** 防复发：病根同样在薄壳（`createOrder` 的 catch 里什么都不做）。 */
describe('防复发：结算页薄壳执行恢复动作（B37 / AJ-220）', () => {
  const code = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('catch 里必须调 recoveryFor，并按意图执行（重报价 / 重拉条款）', () => {
    expect(code).toContain('recoveryFor(code)');
    expect(code).toContain('this.intentKey?.retire()');
    expect(code).toContain('void this.refresh({ keepError: true })');
    expect(code).toContain('void this.fetchTerms()');
  });

  it('闸门必须把 splitRequired 传进去（B38 / AJ-221：超上限不能放行）', () => {
    // @why vm 里那条判断再对，薄壳不传这个字段也等于没接。
    expect(code).toContain('splitRequired');
  });

  it('重报价必须连带作废幂等键（价格变了 = 意图内容变了，同键会被拒）', () => {
    const i = code.indexOf("recoveryFor(code) === 'requote'");
    expect(i, '自检：requote 分支存在').toBeGreaterThan(-1);
    const branch = code.slice(i, code.indexOf('} else if', i));
    expect(branch, 'requote 分支里必须 retire').toContain('retire()');
  });
});
