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
  intentForRow,
  pendingRemoval,
  quoteRetryable,
  undoAvailable,
  undoView,
  UNDO_WINDOW_MS,
  selectionBar,
  stockAdjust,
  priceChangeNote,
  goneQuoteError,
  lineMaxNote,
} from './index.vm.js';
import { SALES_PAUSED_TEXT } from '../../utils/error-text.js';

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
      priceText: '3,600 日元',
      selected: true, // A3（AJ-416）
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
    // 精确值：报价一处 + 清空购物车时作废在途报价一处 + 库存调整后作废本次结果一处（AJ-493）
    expect(count('nextSeq(this.quoteSeq)'), '领号三处（报价 + 清空作废 + 库存调整作废）').toBe(3);
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
  // 审计 CPY-05：闸门提示用的就是 error-text.js 里那一份，不在这里另写一句短版
  it('40916 → 说"暂停接单"，不说"合计未能获取，请稍后重试"', () => {
    const g = checkoutGate({ hasError: true, errorCode: 40916, lineCount: 1 });
    expect(g.disabled).toBe(true);
    expect(g.hint).toContain('暂停接单');
    expect(g.hint).toBe(SALES_PAUSED_TEXT);
  });
});

describe('M-14 购物车：行进详情 / 删除撤销 / 报价重试（AJ-406）', () => {
  const T0 = Date.parse('2026-10-08T03:00:00.000Z');
  const ITEMS = [
    {
      productId: 'p-shiro-cleansing-oil',
      qty: 1,
      title: '資生堂 クレンジングオイル 200ml',
      image: '',
      priceJpy: 3600,
    },
    {
      productId: 'p-sakai-gyuto-210',
      qty: 2,
      title: '堺孝行 牛刀 210mm',
      image: '',
      priceJpy: 18_700,
    },
  ];

  it('intentForRow：有 id → 去详情；空 / 非字符串 → null', () => {
    expect(intentForRow('p-sakai-gyuto-210')).toEqual({ go: 'detail', id: 'p-sakai-gyuto-210' });
    expect(intentForRow('')).toBeNull();
    expect(intentForRow(undefined)).toBeNull();
  });

  it('🔴 删第 2 行 → 记下原下标与快照；窗口内可撤销，"已删除「…」"插回原位', () => {
    const p = pendingRemoval(ITEMS, 'p-sakai-gyuto-210', T0);
    expect(p).toEqual({ item: ITEMS[1], index: 1, expiresAt: T0 + UNDO_WINDOW_MS });
    expect(undoAvailable(p, T0 + UNDO_WINDOW_MS - 1)).toBe(true);
    expect(undoView(p, T0 + 1000)).toEqual({
      show: true,
      index: 1,
      text: '已删除「堺孝行 牛刀 210mm」',
    });
  });

  it('🔴 到点（含恰好等于 expiresAt）→ 不能撤销、那一行消失', () => {
    const p = pendingRemoval(ITEMS, 'p-sakai-gyuto-210', T0);
    expect(undoAvailable(p, T0 + UNDO_WINDOW_MS)).toBe(false);
    expect(undoView(p, T0 + UNDO_WINDOW_MS + 1)).toEqual({ show: false, index: -1, text: '' });
  });

  it('找不到那一件 / 入参脏 / 没有时刻 → 不可撤销', () => {
    expect(pendingRemoval(ITEMS, 'p-none', T0)).toBeNull();
    expect(pendingRemoval(null, 'p-sakai-gyuto-210', T0)).toBeNull();
    expect(pendingRemoval(ITEMS, 'p-sakai-gyuto-210', Number.NaN)).toBeNull();
    expect(undoAvailable(null, T0)).toBe(false);
    expect(undoAvailable({ expiresAt: T0 + 1 }, undefined)).toBe(false);
  });

  it('缺标题 → 通用说法（不显示空引号）', () => {
    const p = pendingRemoval([{ productId: 'p-x', qty: 1 }], 'p-x', T0);
    expect(undoView(p, T0).text).toBe('已删除这件商品');
  });

  it('quoteRetryable：网络 / 5xx / 库存不足给重试；下架、超重、超上限、品种超限、停售、账号被拉黑不给', () => {
    expect(quoteRetryable(-1, 1, false)).toBe(true);
    expect(quoteRetryable(50000, 1, false)).toBe(true);
    expect(quoteRetryable(40901, 1, false)).toBe(true);
    // F4（第二轮审计 2026-10-11）：账号被拉黑，重试永远不会成功
    for (const code of [40401, 40906, 40912, 40916])
      expect(quoteRetryable(code, 1, false), String(code)).toBe(false);
    expect(quoteRetryable(40301, 1, true)).toBe(false);
    expect(quoteRetryable(40001, 51, false)).toBe(false);
    expect(quoteRetryable(40001, 3, false)).toBe(true);
  });

  /**
   * 规律排查（本轮）：40301 里只有"被拉黑"重试无用。另一个买家可达的成因是**源站校验失败**
   * （`server/src/http.ts` 的 `origin_not_verified`，只接受经 Cloudflare 的流量）——
   * 那是基础设施故障，修好之后重试是**有效**的。原先这里 `code === 40301` 一律返回 false，
   * 于是 CF 头注入坏掉时，全体买家不但读到"账号已被限制"，连「重试」按钮都没有——
   * 只能去找客服，而客服查不出任何问题（规律①：修一处不扫同类）。
   */
  it('🔴 40301 但成因不是拉黑（源站校验失败）→ 仍给「重试」；被拉黑才不给', () => {
    expect(quoteRetryable(40301, 1, false)).toBe(true);
    expect(quoteRetryable(40301, 1, true)).toBe(false);
  });
});

describe('勾选结算（A3，AJ-416）', () => {
  it('🔴 行带勾选状态（缺字段 = 已勾选）', () => {
    const rows = cartRows([
      { productId: 'p-1', qty: 1, title: 'a' },
      { productId: 'p-2', qty: 1, title: 'b', selected: false },
    ]);
    expect(rows.map((r) => r.selected)).toEqual([true, false]);
  });

  it('🔴 底栏：全选状态 + 「去结算 (N)」——N 是勾选的品种数；一件没勾时按钮只写"去结算"', () => {
    expect(selectionBar([{ selected: true }, { selected: true }])).toEqual({
      allSelected: true,
      selectedCount: 2,
      ctaText: '去结算（2）',
    });
    expect(selectionBar([{ selected: true }, { selected: false }])).toEqual({
      allSelected: false,
      selectedCount: 1,
      ctaText: '去结算（1）',
    });
    expect(selectionBar([{ selected: false }])).toEqual({
      allSelected: false,
      selectedCount: 0,
      ctaText: '去结算',
    });
    expect(selectionBar(null)).toEqual({ allSelected: false, selectedCount: 0, ctaText: '去结算' });
  });

  it('🔴 一件没勾 → 去结算不可点，并说清楚为什么（优先于"还在计算"）', () => {
    expect(checkoutGate({ noneSelected: true, quoting: true })).toEqual({
      disabled: true,
      hint: '请勾选要结算的商品',
    });
  });
});

describe('报价失败的出路要说全（三端联动走查 2026-10-08）', () => {
  it('🔴 下架 / 库存不足这类"必须改购物车"的失败：提示里给出"取消勾选"这条路（A3 之后它最省事）', () => {
    expect(checkoutGate({ hasError: true, errorCode: 40401, lineCount: 2 }).hint).toBe(
      '有商品无法购买：移除或取消勾选标红的商品后再结算',
    );
  });

  it('🔴 行内标红与报价错误的链路号各占一行（原先"3,850 日元已下架…"、"…已下架错误码 40401"粘在一起）', () => {
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8');
    expect(wxml).toMatch(
      /<text class="[^"]*\bline-block\b[^"]*" wx:if="\{\{item\.invalidText\}\}"/,
    );
    expect(wxml).toMatch(/<text class="[^"]*\bline-block\b[^"]*" wx:if="\{\{quoteErrorRef\}\}"/);
  });
});

describe('第二轮审计 2026-10-11：购物车结算提示（F2 / F4）', () => {
  it('🔴 F2 进页面首次报价：说"正在计算"，不说"数量已改"（用户什么都没改）', () => {
    const enter = checkoutGate({ quoting: true, reason: 'enter' });
    expect(enter.disabled).toBe(true);
    expect(enter.hint).toBe('正在计算运费与合计…');
    // 改了购物车（数量 / 勾选 / 删除）：仍说"重新计算"，且不再只说"数量"（勾选变化也走这条）
    const changed = checkoutGate({ quoting: true });
    expect(changed.hint).toContain('重新计算');
    expect(changed.hint).not.toContain('数量已改');
  });

  it('🔴 F4 账号被拉黑（40301 + blocked）：提示说账号受限，不说"稍后重试"', () => {
    const g = checkoutGate({ hasError: true, errorCode: 40301, errorBlocked: true, lineCount: 1 });
    expect(g.disabled).toBe(true);
    expect(g.hint).toContain('账号');
    expect(g.hint).not.toContain('稍后重试');
  });

  /**
   * 规律排查（本轮）：40301 的成因不止一种，**源站校验失败**（`origin_not_verified`）买家同样碰得到。
   * 原先 `quoteErrorHint` 照码判，把一次基础设施故障说成"你的账号被限制使用"——
   * 买家去找客服，客服那边一切正常（规律①：修一处不扫同类）。
   */
  it('🔴 40301 但不是拉黑（源站校验失败）→ 说"稍后重试"，不说账号被限制', () => {
    const g = checkoutGate({ hasError: true, errorCode: 40301, errorBlocked: false, lineCount: 1 });
    expect(g.hint).not.toContain('账号');
    expect(g.hint).toContain('稍后重试');
  });
});

// 全入口点击测试 2026-10-11（AJ-493）：库存只剩 1 件的商品在购物车里能点到 2，之后整单报价失败、合计消失、
// 底部说"请稍后重试"。报价的 40901 现在带 stock（可买件数）→ 改到可买件数并说明；0 件 → 标"已售罄，请移除"
describe('stockAdjust（库存不足时改到可买件数）', () => {
  const rows = [
    { productId: 'p-1', qty: 2 },
    { productId: 'p-2', qty: 1 },
  ];
  const err = (data: unknown, code = 40901) => ({ code, data });

  it('🔴 可买件数 < 购物车件数 → 改到可买件数，并给一句说明', () => {
    expect(stockAdjust(rows, err({ product_id: 'p-1', stock: 1 }))).toEqual({
      productId: 'p-1',
      qty: 1,
      text: '库存只剩 1 件，已改为 1 件',
    });
  });

  it('🔴 可买件数为 0 → 不改数量，标"已售罄，请移除"', () => {
    expect(stockAdjust(rows, err({ product_id: 'p-1', stock: 0 }))).toEqual({
      productId: 'p-1',
      qty: 0,
      text: '已售罄，请移除',
    });
  });

  it('不调整：别的码 / 没带 stock / 不在车里 / 可买件数并不少于车里件数（报价后库存又回补）', () => {
    expect(stockAdjust(rows, err({ product_id: 'p-1', stock: 1 }, 40401))).toBeNull();
    expect(stockAdjust(rows, err({ product_id: 'p-1' }))).toBeNull();
    expect(stockAdjust(rows, err({ product_id: 'p-9', stock: 1 }))).toBeNull();
    expect(stockAdjust(rows, err({ product_id: 'p-2', stock: 3 }))).toBeNull();
    expect(stockAdjust(null as never, null)).toBeNull();
  });
});

// 两端逐页走查第三轮 2026-10-12：改价后行价被悄悄刷新，买家不知道多付了钱
describe('priceChangeNote', () => {
  it('🔴 涨价 / 降价都说清从多少变成多少', () => {
    expect(priceChangeNote(1980, 2480)).toBe('价格已由 1,980 日元调整为 2,480 日元');
    expect(priceChangeNote(2480, 1980)).toBe('价格已由 2,480 日元调整为 1,980 日元');
  });
});

// 两端逐页走查第三轮 2026-10-12：下架时错误条写"商品不存在或已下架"并带报障编号——下架是正常状态，不是故障；
//   售罄早已改成"「名称」已售罄，移除后才能结算"（AJ-493），两者同口径
describe('goneQuoteError', () => {
  it('🔴 写明是哪件下架了、怎么办；名称缺失时给通用说法', () => {
    expect(goneQuoteError('有田烧 名窑 染付 大花瓶 尺二')).toBe(
      '「有田烧 名窑 染付 大花瓶 尺二」已下架，移除后才能结算',
    );
    expect(goneQuoteError('')).toBe('有商品已下架，移除后才能结算');
  });
});

describe('lineMaxNote（规律排查 2026-10-12）', () => {
  it('🔴 99 再加 → 说上限；没到 / 减 → 空', () => {
    expect(lineMaxNote(99, 1)).toBe('每件商品一次最多买 99 件');
    expect(lineMaxNote(98, 1)).toBe('');
    expect(lineMaxNote(99, -1)).toBe('');
  });
});
