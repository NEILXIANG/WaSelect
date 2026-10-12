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
  checkoutItems,
  clearsCartAfterOrder,
  EMAIL_REQUIRED_TEXT,
  contactEmailOf,
  emailInputError,
  itemRows,
  keyAction,
  orderBody,
  recoveryFor,
  resolveAddressId,
  goneExit,
  submitGate,
} from './index.vm.js';
import { namedItemError, rowsWithQuotePrice, termsFromResponse } from './index.vm.js';

const ITEMS = [
  { productId: 'p-shiro-cleansing-oil', qty: 2, title: '資生堂 クレンジングオイル 200ml' },
  { productId: 'p-knife-210mm', qty: 1, title: '堺孝行 柳刃包丁 210mm' },
];

describe('itemRows（商品行）', () => {
  it('只给标题、数量与主图——⚠️ **没有价格字段**', () => {
    const [row] = itemRows(ITEMS);
    expect(row).toEqual({
      productId: 'p-shiro-cleansing-oil',
      qty: 2,
      title: '資生堂 クレンジングオイル 200ml',
      image: '',
    });
    // 价格一旦出现在这里，就会有人拿它算合计——而快照价会过期
    expect(Object.keys(row ?? {})).not.toContain('priceJpy');
    expect(Object.keys(row ?? {})).not.toContain('priceText');
  });

  it('🔴 带加购时的主图快照（A6：结算页商品行要有缩略图，只有文字认不出买的是哪件）', () => {
    const [row] = itemRows([{ ...ITEMS[0], image: 'https://img.example/c.webp' }]);
    expect(row?.image).toBe('https://img.example/c.webp');
    expect(itemRows([{ ...ITEMS[0], image: 42 }])[0]?.image).toBe('');
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

  // 全入口点击测试 2026-10-11（用户截图问"提交订单这个按钮符合预期吗"）：浅灰禁用按钮看不出能不能点，
  // 条款勾选框还在两屏之下。主流做法：按钮常亮，点了把人带到缺的那一项。`fix` 说明"缺的这一项买家在本页能补"。
  it('🔴 买家在本页能补的三项带 fix：地址 / 条款 / 邮箱；补不了的（报价失败、超上限、条款取不到、地址没取到）fix 为空', () => {
    expect(submitGate({ ...OK, addressId: '' }).fix).toBe('address');
    expect(submitGate({ ...OK, termsAccepted: false }).fix).toBe('terms');
    expect(submitGate({ ...OK, emailError: '邮箱格式不正确' }).fix).toBe('email');
    expect(submitGate({ ...OK, contactEmail: '' }).fix).toBe('email');
    expect(submitGate({ ...OK, addressId: '', addressFailed: true }).fix).toBe('');
    expect(submitGate({ ...OK, termsFailed: true }).fix).toBe('');
    expect(submitGate({ ...OK, quoteFailed: true }).fix).toBe('');
    expect(submitGate({ ...OK, splitRequired: true }).fix).toBe('');
    expect(submitGate({ ...OK, totalJpy: null }).fix).toBe('');
    expect(submitGate({ ...OK, itemCount: 0 }).fix).toBe('');
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
 * 联系邮箱（PRD §3 确认订单 / D-39；提审前必须，AJ-180；M-01 / AJ-405 起前端必填，契约仍可选）。
 * ⚠️ AJ-295：原名"收货通知邮箱"——通知链路无使用方，改名以匹配真实用途。
 * @why 必填：订阅消息未开通，不填就收不到付款 / 发货 / 退款通知；填了就必须是服务端会收的形状——否则"提交 → 40001"
 *      给出的是泛化的"参数错误"，用户不知道错在邮箱。口径与服务端入口一致（有 @、无空白、≤255）。
 */
describe('contactEmailOf（联系邮箱，M-01 起前端必填）', () => {
  // M-01（AJ-405 / AJ-402 Q1）：原断言"空 → 不拦"与新口径（前端必填）相反，按新口径改；契约与服务端仍可选
  it('🔴 空 / 纯空白 / 非字符串 → 不带（value 为空串），且给出"为什么要填"的原因', () => {
    for (const raw of ['', '   ', undefined, null, 42]) {
      const r = contactEmailOf(raw);
      expect(r.value, String(raw)).toBe('');
      expect(r.error, String(raw)).toBe(EMAIL_REQUIRED_TEXT);
    }
    // 原因要说清用途（APPI：收集时告知的利用目的与实际一致；AJ-369 订单邮件）
    for (const w of ['付款', '发货', '退款']) expect(EMAIL_REQUIRED_TEXT).toContain(w);
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
      // M-01：去掉"（可留空）"——必填之后那半句是错的（原断言文案按新口径改）
      expect(contactEmailOf(bad).error, bad).toBe('邮箱格式不正确，应类似 name@gmail.com');
    }
  });

  it('submitGate：邮箱有错 → 不可提交且原因指向邮箱；其余四项的原因优先', () => {
    const OK = { itemCount: 2, addressId: 'addr-1', termsAccepted: true, totalJpy: 9150 };
    expect(submitGate({ ...OK, emailError: '邮箱格式不正确（可留空）' })).toEqual({
      ok: false,
      reason: '邮箱格式不正确（可留空）',
      fix: 'email', // 2026-10-11：买家能补的一项，点提交会带到邮箱框
    });
    expect(submitGate({ ...OK, itemCount: 0, emailError: 'x' }).reason).toBe('购物车是空的');
    expect(submitGate({ ...OK, emailError: '' }).ok).toBe(true);
  });

  it('🔴 M-01 submitGate：传了 contactEmail 且为空 → 不可提交，原因说明邮箱用途；排在其余各项之后', () => {
    const OK = { itemCount: 2, addressId: 'addr-1', termsAccepted: true, totalJpy: 9150 };
    expect(submitGate({ ...OK, contactEmail: '' })).toEqual({
      ok: false,
      reason: EMAIL_REQUIRED_TEXT,
      fix: 'email',
    });
    expect(submitGate({ ...OK, contactEmail: 'jane@example.com' })).toEqual({
      ok: true,
      reason: '',
    });
    // 能不能下单的前几项先说（空购物车时先说购物车，不先催邮箱）
    expect(submitGate({ ...OK, itemCount: 0, contactEmail: '' }).reason).toBe('购物车是空的');
    // 填了但格式错：说格式，不说"请填写"
    expect(
      submitGate({ ...OK, contactEmail: '', emailError: '邮箱格式不正确，应类似 name@gmail.com' })
        .reason,
    ).toBe('邮箱格式不正确，应类似 name@gmail.com');
  });

  it('不传 contactEmail = 不检查（老调用方不受影响，与 termsReady 等同一口径）', () => {
    const OK = { itemCount: 2, addressId: 'addr-1', termsAccepted: true, totalJpy: 9150 };
    expect(submitGate(OK).ok).toBe(true);
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

  it('40912（包裹超重）/ 40906（超单笔上限）→ 重新报价（P2-40：报价会给出拆单提示，而不是停在一句错误上）', () => {
    expect(recoveryFor(40912)).toBe('requote');
    expect(recoveryFor(40906)).toBe('requote');
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
    for (const c of [40905, 40901, 40401, 40011, 40913, 40912, 40906]) {
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

/** 剩余清单 4-4：立即购买走结算页时，条目来源与"建单后清不清购物车"。 */
describe('checkoutItems / clearsCartAfterOrder（4-4）', () => {
  const BUY = { productId: 'p-knife', qty: 1, title: '出刃包丁' };

  it('🔴 buynow 模式 → 只结这一件（不碰购物车）；普通模式 → 购物车', () => {
    expect(checkoutItems({ mode: 'buynow', buyNow: BUY, cartItems: ITEMS })).toEqual([BUY]);
    expect(checkoutItems({ mode: '', buyNow: BUY, cartItems: ITEMS })).toEqual(ITEMS);
  });

  it('🔴 普通模式只结勾选的（A3，AJ-416）：selected === false 的留在车里；缺字段 = 勾选', () => {
    const rows = [
      { productId: 'p-a', qty: 1, title: 'a', selected: true },
      { productId: 'p-b', qty: 1, title: 'b', selected: false },
      { productId: 'p-c', qty: 1, title: 'c' },
    ];
    expect(
      checkoutItems({ mode: '', buyNow: null, cartItems: rows }).map((i) => i.productId),
    ).toEqual(['p-a', 'p-c']);
  });

  it('buynow 模式但单件丢了（进程被回收 / 脏值）→ 空数组（结算页显示空态），不回落到购物车', () => {
    expect(checkoutItems({ mode: 'buynow', buyNow: null, cartItems: ITEMS })).toEqual([]);
    expect(checkoutItems({ mode: 'buynow', buyNow: { productId: '' }, cartItems: ITEMS })).toEqual(
      [],
    );
  });

  it('🔴 建单成功后：普通模式清车；buynow 模式**不**清车（购物车里的东西用户没打算现在买）', () => {
    expect(clearsCartAfterOrder('')).toBe(true);
    expect(clearsCartAfterOrder('buynow')).toBe(false);
  });
});

describe('namedItemError（U9，三端联动模拟 2026-10-08）', () => {
  const items = [
    { productId: 'p-1', title: '东京香蕉蛋糕 8 个装', qty: 1 },
    { productId: 'p-2', title: '京都宇治抹茶粉 100g', qty: 1 },
  ];
  it('🔴 40401 / 40901 带 product_id → 点名是哪一件', () => {
    expect(namedItemError({ code: 40401, data: { product_id: 'p-2' } }, items)).toBe(
      '「京都宇治抹茶粉 100g」已下架或不存在，请返回购物车移除后再下单',
    );
    expect(namedItemError({ code: 40901, data: { product_id: 'p-1' } }, items)).toContain(
      '「东京香蕉蛋糕 8 个装」库存不足',
    );
  });
  it('其它码 / 没带 id / id 不在这次的商品里 → 空串（沿用通用文案，不猜）', () => {
    expect(namedItemError({ code: 40905, data: { product_id: 'p-1' } }, items)).toBe('');
    expect(namedItemError({ code: 40401 }, items)).toBe('');
    expect(namedItemError({ code: 40401, data: { product_id: 'p-x' } }, items)).toBe('');
    expect(namedItemError(null, items)).toBe('');
  });
});

describe('立即购买模式的失败文案（审查 2026-10-09）', () => {
  const items = [{ productId: 'p-1', qty: 1, title: '南部鉄器 急須' }];
  it('🔴 buyNow：点名文案不让人"返回购物车"（那件商品根本不在购物车里）', () => {
    const e40401 = { code: 40401, data: { product_id: 'p-1' } };
    const e40901 = { code: 40901, data: { product_id: 'p-1' } };
    expect(namedItemError(e40401, items, { buyNow: true })).toBe(
      '「南部鉄器 急須」已下架或不存在，暂时不能购买',
    );
    expect(namedItemError(e40901, items, { buyNow: true })).toBe(
      '「南部鉄器 急須」库存不足，暂时不能购买',
    );
    expect(namedItemError(e40401, items)).toContain('请返回购物车');
  });
  it('🔴 buyNow：报价失败的闸门说法不提购物车', () => {
    const OK = { itemCount: 1, addressId: 'addr-1', termsAccepted: true, totalJpy: 9150 };
    expect(submitGate({ ...OK, quoteFailed: true, buyNow: true }).reason).toBe(
      '报价失败，请返回商品页后重试',
    );
    expect(submitGate({ ...OK, quoteFailed: true }).reason).toContain('返回购物车');
  });
});

// 联动走查·跨角色（2026-10-10）：买家停在结算页时运营下架了商品——提交得 40401，重报价也是 40401，
// 页面只给「重新加载」、底部说"请返回商品页后重试"，两条都走不通（商品页也是"已下架"）。
describe('商品已下架（报价 / 建单 40401）：给走得通的出口', () => {
  it('🔴 立即购买 → 回首页看其它商品；购物车结算 → 回购物车删掉它', () => {
    expect(goneExit(true)).toEqual({
      actionText: '回首页看看其它商品',
      hint: '这件商品已下架，请回首页看看其它商品',
      target: 'home',
    });
    expect(goneExit(false)).toEqual({
      actionText: '回购物车调整',
      hint: '有商品已下架，请回购物车删掉它再结算',
      target: 'cart',
    });
  });

  it('🔴 闸门：商品已下架时说下架，不说"报价失败请重试"', () => {
    const base = {
      itemCount: 1,
      addressId: 'a-1',
      termsAccepted: true,
      totalJpy: null,
      termsReady: true,
      quoteFailed: true,
      productGone: true,
    };
    expect(submitGate({ ...base, buyNow: true }).reason).toBe(
      '这件商品已下架，请回首页看看其它商品',
    );
    expect(submitGate({ ...base, buyNow: false }).reason).toBe(
      '有商品已下架，请回购物车删掉它再结算',
    );
    expect(submitGate({ ...base, productGone: false, buyNow: true }).reason).toBe(
      '报价失败，请返回商品页后重试',
    );
    // 没勾条款、没选地址时也先说下架：买不了的东西不该先让人去勾条款
    expect(
      submitGate({
        itemCount: 1,
        addressId: '',
        termsAccepted: false,
        totalJpy: null,
        productGone: true,
        buyNow: true,
      }).reason,
    ).toBe('这件商品已下架，请回首页看看其它商品');
  });
});

/**
 * 条款就绪 = 有版本**且**有可打开的条款地址（严格检查 M-1b，AJ-441）。
 * @why 此前只看版本号：服务端没配条款地址时 `/terms` 整键省略 urls，结算页仍放行"已阅读并同意"——
 *      买家同意了一份打不开的条款。服务端生产已拒启这种配置（config 规则 9c），这里是客户端那一道。
 */
describe('termsFromResponse', () => {
  const URLS = { zh: 'https://legal.waselect.jp/legal/terms/#zh', ja: 'x', en: 'y' };
  it('有版本有地址 → 就绪', () => {
    expect(termsFromResponse({ version: 'TOS-2026-09-20', urls: URLS })).toEqual({
      termsVersion: 'TOS-2026-09-20',
      termsFailed: false,
    });
  });
  it.each([
    ['没有 urls（服务端未配条款地址）', { version: 'TOS-2026-09-20' }],
    ['urls.zh 是空白', { version: 'TOS-2026-09-20', urls: { zh: '  ' } }],
    ['没有版本', { urls: URLS }],
    ['响应不是对象', null],
  ])('%s → 不就绪（闸门说"条款暂时取不到"，不放行同意）', (_n, res) => {
    expect(termsFromResponse(res).termsFailed).toBe(true);
  });
  it('没有地址时版本仍原样给出（建单回传用），只是标记失败', () => {
    expect(termsFromResponse({ version: 'TOS-2026-09-20' }).termsVersion).toBe('TOS-2026-09-20');
  });
});

describe('第二轮审计 2026-10-11：结算页（F4 / F5 / F7 / MP-9）', () => {
  const OK = { itemCount: 1, addressId: 'a-1', termsAccepted: true, totalJpy: 9150 };

  it('🔴 F4 报价失败的原因按码说：停售 / 账号受限不说"返回购物车重试"', () => {
    const fail = (quoteErrorCode: number) =>
      submitGate({ ...OK, totalJpy: null, quoteFailed: true, quoteErrorCode }).reason;
    expect(fail(40916)).toContain('暂停接单');
    expect(fail(40916)).not.toContain('重试');
    expect(fail(40301)).toContain('账号');
    expect(fail(40301)).not.toContain('重试');
    expect(fail(50000)).toContain('购物车');
  });

  it('🔴 F5 地址没取到 → 说"没取到"，不说"请选择收货地址"（用户会以为自己没有地址）', () => {
    const g = submitGate({ ...OK, addressId: '', addressFailed: true });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('没取到');
    expect(submitGate({ ...OK, addressId: '' }).reason).toBe('请选择收货地址');
  });

  it('🔴 F7 输入中不抢先报格式错；已经报过错时，改对了立即消失、没改对继续显示', () => {
    expect(emailInputError('jane@', '')).toBe('');
    expect(emailInputError('jane@example.com', '邮箱格式不正确，应类似 name@gmail.com')).toBe('');
    expect(emailInputError('jane@', '邮箱格式不正确，应类似 name@gmail.com')).toBe(
      '邮箱格式不正确，应类似 name@gmail.com',
    );
    // 清空是用户主动删掉的：立即说明为什么要填（M-01 口径不变）
    expect(emailInputError('   ', '')).toBe(EMAIL_REQUIRED_TEXT);
  });

  it('🔴 MP-9 contactEmailOf 用收紧后的判据：a@b / 连点 / 后缀太短 → 格式不正确', () => {
    for (const bad of ['a@b', 'x@b..com', 'x@b.c', 'x@b.123']) {
      expect(contactEmailOf(bad).error, bad).toBe('邮箱格式不正确，应类似 name@gmail.com');
    }
    expect(contactEmailOf('li.wei@163.com')).toEqual({ value: 'li.wei@163.com', error: '' });
  });
});

// 全入口点击测试 2026-10-11：商品行只有"× 1"没有单价（主流确认页每行都有单价）。单价只取报价的 lines（服务端当前价），不用购物车快照
describe('rowsWithQuotePrice（商品行单价，来自报价）', () => {
  const rows = itemRows(ITEMS);
  const quote = {
    total_jpy: 9990,
    lines: [
      { product_id: 'p-shiro-cleansing-oil', unit_price_jpy: 2070 },
      { product_id: 'p-knife-210mm', unit_price_jpy: 12800 },
    ],
  };

  it('🔴 按商品 id 配上报价单价，只给展示文字（不给数字字段，免得有人拿它算合计）', () => {
    const out = rowsWithQuotePrice(rows, quote);
    expect(out.map((r) => r.priceText)).toEqual(['2,070 円', '12,800 円']);
    expect(out[0]).toEqual({ ...rows[0], priceText: '2,070 円' });
  });

  it('🔴 还没报价 / 报价失败 / 报价里没有这一行 / 单价不是整数 → 不显示单价（空串）', () => {
    expect(rowsWithQuotePrice(rows, null).map((r) => r.priceText)).toEqual(['', '']);
    expect(
      rowsWithQuotePrice(rows, {
        lines: [{ product_id: 'p-knife-210mm', unit_price_jpy: 12.5 }],
      }).map((r) => r.priceText),
    ).toEqual(['', '']);
    expect(rowsWithQuotePrice(rows, { lines: 'x' }).map((r) => r.priceText)).toEqual(['', '']);
    expect(rowsWithQuotePrice('x', quote)).toEqual([]);
  });
});
