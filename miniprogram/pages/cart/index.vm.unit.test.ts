/**
 * 职责：购物车页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的是"错了不报错"的事：
 *      ① 行里出现小计 → 小计是"算合计"的半成品，走缓存价就破了红线
 *        （cart-store @limitation 一：价格变了没人发现）；
 *      ② 快照价非整数（旧版本脏数据）→ 整行渲染失败，而它只是参考信息。
 *
 * @why **报价区不在这里**：`quoteView` 已下沉到 `utils/quote-view.js`
 *      （确认订单页渲染同一块），它的守卫在 `quote-view.unit.test.ts`。
 *
 * @see ./index.vm.js
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOO_MANY_LINES_TEXT,
  cartRows,
  checkoutGate,
  markInvalid,
  quoteErrorText,
} from './index.vm.js';

const ITEMS = [
  {
    productId: 'p-shiro-cleansing-oil',
    qty: 2,
    title: '資生堂 クレンジングオイル 200ml',
    image: 'https://img.example.com/p1/card.jpg',
    priceJpy: 3600,
  },
];

describe('cartRows（行视图）', () => {
  it('字段透传 + 快照价格式化（仅参考，不产出小计）', () => {
    const [row] = cartRows(ITEMS);
    expect(row).toEqual({
      productId: 'p-shiro-cleansing-oil',
      title: '資生堂 クレンジングオイル 200ml',
      image: 'https://img.example.com/p1/card.jpg',
      qty: 2,
      priceText: '3,600 円',
    });
    // ⚠️ 没有 subtotal 字段：行内小计 = "算合计"的半成品，走缓存价就破了红线
    expect(Object.keys(row ?? {})).not.toContain('subtotalText');
  });

  it('⚠️ 快照价非整数（旧版本脏数据）→ 不显示，而不是让整行渲染失败', () => {
    expect(cartRows([{ ...ITEMS[0], priceJpy: 3600.5 }])[0]?.priceText).toBe('');
    expect(cartRows([{ ...ITEMS[0], priceJpy: undefined }])[0]?.priceText).toBe('');
  });

  it('脏输入：非数组 → 空数组；qty 非整数 → 归一成 1', () => {
    expect(cartRows(undefined as never)).toEqual([]);
    expect(cartRows([{ productId: 'p-1', qty: '2' }])[0]?.qty).toBe(1);
  });
});

describe('checkoutGate：去结算能不能点、下面写什么（B36 / AJ-219）', () => {
  it('有权威合计 → 可点，不显示提示', () => {
    expect(checkoutGate({ hasTotal: true })).toEqual({ disabled: false, hint: '' });
  });

  it('还没报价 → 禁用 + "还在计算中"', () => {
    expect(checkoutGate({})).toEqual({ disabled: true, hint: '运费与合计还在计算中' });
    expect(checkoutGate(undefined).disabled).toBe(true);
    expect(checkoutGate(null).disabled).toBe(true);
  });

  it('⚠️ 改了数量、新合计还没回来 → 禁用，且不能沿用"还在计算中"', () => {
    // @why 旧 quote 还在页面上，若只按 hasTotal 判，按钮就是可点的——
    //      而那个合计对应的是**改数量之前**的那一版，会带着过期的
    //      expected_total_jpy 进结算页（40905 防线被自己喂一个旧值）。
    const g = checkoutGate({ quoting: true, hasTotal: true });
    expect(g.disabled).toBe(true);
    expect(g.hint).toContain('重新计算');
    expect(g.hint).not.toBe('运费与合计还在计算中');
  });

  it('报价失败 → 说"未能获取"并给下一步；不能再说"还在计算中"（它永远算不出来）', () => {
    const g = checkoutGate({ hasError: true });
    expect(g.disabled).toBe(true);
    expect(g.hint).toContain('重试');
    expect(g.hint).not.toContain('还在计算中');
  });

  it('已超过单笔上限（splitRequired）→ 禁用并说清原因（B38 / AJ-221）', () => {
    // @why 结算页会 40906。在购物车就关掉入口，让用户在**能改数量**的这一页解决，
    //      而不是跳过去再被弹回来（弹回来时他还得猜是哪一件的数量问题）。
    const g = checkoutGate({ hasTotal: true, splitRequired: true });
    expect(g.disabled).toBe(true);
    expect(g.hint).toBe('已超过单笔上限，请分两单下单');
  });

  /**
   * MP3-09：确定性失败（下架 / 超重 / 超金额上限）被说成"请稍后重试"——
   * 错误条上写"请拆单"、按钮下写"稍后重试"，两句话方向相反，而重试永远不会好。
   */
  it('🔴 超重（40912）不许说"稍后重试"：它不会自己变轻，必须改购物车', () => {
    const g = checkoutGate({ hasError: true, errorCode: 40912 });
    expect(g.disabled).toBe(true);
    expect(g.hint).not.toContain('稍后重试');
    expect(g.hint).toContain('调整数量');
  });

  it('🔴 商品下架（40401）与超金额上限（40906）同理：同属"用户不改就永远好不了"', () => {
    for (const code of [40401, 40906]) {
      expect(checkoutGate({ hasError: true, errorCode: code }).hint, String(code)).not.toContain(
        '稍后重试',
      );
    }
  });

  it('库存不足（40901）与网络错误 → 仍然说"稍后重试"（库存会被别人的取消回补）', () => {
    for (const code of [40901, 0, undefined, -1, 50000]) {
      expect(checkoutGate({ hasError: true, errorCode: code }).hint, String(code)).toContain(
        '稍后重试',
      );
    }
  });

  it('三种状态两两不同（同一句话盖住两种状态正是 B36 的病根）', () => {
    const hints = [
      checkoutGate({ quoting: true }).hint,
      checkoutGate({ hasError: true }).hint,
      checkoutGate({}).hint,
    ];
    expect(new Set(hints).size, `三条提示必须互不相同：${hints.join(' / ')}`).toBe(3);
  });
});

/**
 * 防复发：B36 的病根同样**在薄壳**（取数不看序号、按钮状态写死），
 * vm 的纯函数用例在薄壳漏接线时一条都不会红（与 AJ-217 / AJ-218 同一条理由）。
 */
describe('防复发：购物车薄壳的乱序接线（B36 / AJ-219）', () => {
  const code = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const count = (needle: string): number => code.split(needle).length - 1;

  it('自检：计数函数对已知文本有效（否则下面全是"0 >= n"的假红或"0 === 0"的假绿）', () => {
    expect(count('wxApi'), '自检：wxApi 在薄壳里确实出现').toBeGreaterThan(0);
    expect(count('这段字符串根本不存在')).toBe(0);
  });

  it('报价必须领号并在结果回来时判过期（连点 +/- 后旧合计不能盖回去）', () => {
    // 精确值：报价一处 + 清空购物车时作废在途报价一处
    expect(count('nextSeq(this.quoteSeq)'), '领号两处（报价 + 清空作废）').toBe(2);
    expect(count('isStale(seq, this.quoteSeq)'), '判过期三处（成功 / 失败 / finally）').toBe(3);
  });

  it('按钮状态走 checkoutGate，不再用写死的 checkoutHint 常量', () => {
    expect(code).toContain('checkoutGate(');
    expect(code).not.toContain('CHECKOUT_HINT');
  });

  it('薄壳必须把 splitRequired 传进 gate（B38 / AJ-221：超上限要在购物车就拦住）', () => {
    // ⚠️ 精确计数而不是 `toContain`：报价成功与 finally 各有一次，
    //    用 `toContain` 的话删掉其中一处仍然绿——守的是"还有一处"，不是"两处都在"。
    expect(count('splitRequired:'), '报价成功分支 + finally 分支各一处').toBe(2);
  });
});

/** 剩余清单 4-7（M10）：报价失败时标出是哪一件。 */
describe('markInvalid（4-7）', () => {
  const rows = cartRows([
    { productId: 'p-a', qty: 1, title: 'A' },
    { productId: 'p-b', qty: 2, title: 'B' },
  ]);

  it('🔴 40401 → 那一行标"已下架或不存在"；40901 → "库存不足"；其余行不动', () => {
    expect(markInvalid(rows, 'p-b', 40401).map((r) => r.invalidText)).toEqual([
      '',
      '已下架或不存在，请移除',
    ]);
    expect(markInvalid(rows, 'p-a', 40901).map((r) => r.invalidText)).toEqual([
      '库存不足，请减少数量',
      '',
    ]);
  });

  it('没有 product_id / 不认识的码 / id 不在车里 → 全部清空标记（不猜是哪一件）', () => {
    const marked = markInvalid(rows, 'p-a', 40401);
    expect(markInvalid(marked, undefined, 40401).every((r) => r.invalidText === '')).toBe(true);
    expect(markInvalid(rows, 'p-a', 50000).every((r) => r.invalidText === '')).toBe(true);
    expect(markInvalid(rows, 'p-zzz', 40401).every((r) => r.invalidText === '')).toBe(true);
  });
});

describe('品种超限（P2-31）：40001 + 超过 50 种 → 说清怎么办', () => {
  it('40001 且行数 > 50 → 可操作的提示（不是"稍后重试"）', () => {
    const g = checkoutGate({ hasError: true, errorCode: 40001, lineCount: 51 });
    expect(g).toEqual({ disabled: true, hint: TOO_MANY_LINES_TEXT });
    expect(TOO_MANY_LINES_TEXT).toContain('50');
    expect(quoteErrorText(40001, 51, '参数错误')).toBe(TOO_MANY_LINES_TEXT);
  });

  it('40001 但行数没超 → 仍按原口径（不乱归因）', () => {
    expect(checkoutGate({ hasError: true, errorCode: 40001, lineCount: 3 }).hint).toBe(
      '合计未能获取，请稍后重试',
    );
    expect(quoteErrorText(40001, 3, '参数错误')).toBe('参数错误');
    expect(quoteErrorText(40901, 60, '库存不足')).toBe('库存不足');
  });
});

describe('checkoutGate：停售（三端联动模拟 2026-10-08）', () => {
  it('40916 → 说"暂停接单"，不说"合计未能获取，请稍后重试"', () => {
    const g = checkoutGate({ hasError: true, errorCode: 40916, lineCount: 1 });
    expect(g.disabled).toBe(true);
    expect(g.hint).toContain('暂停接单');
  });
});
