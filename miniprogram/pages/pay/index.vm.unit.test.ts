/**
 * 职责：支付页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的是几个"点了之后看起来成功、实际是坏的"分支：
 *      ① 在途连点（B6 / AJ-201）——多打一次发起支付，白占连接与订单行锁；
 *      ② 换通道不换键 —— 拿到**上一个通道**的支付凭据（付错入口）；
 *      ③ 复制短链失败却毫无反应（B34 / AJ-217）——这一屏是微信支付上线前唯一的付款路径。
 *      三条都不会报错，所以只能靠纯函数单测逐分支钉住。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_GUIDE,
  PAY_FAIL_TEXT,
  closedScreen,
  copyResult,
  onShowAction,
  payPageView,
  payStartDecision,
} from './index.vm.js';

const BASE = { paying: false, channel: 'stripe', lastChannel: '', hasKey: true };

describe('payStartDecision（点一下该做什么）', () => {
  it('正常：发起，且首次不换键', () => {
    expect(payStartDecision(BASE)).toEqual({
      kind: 'start',
      channel: 'stripe',
      retireKey: false,
    });
  });

  it('换通道 → retireKey（沿用旧键会被服务端重放成上一个通道的 intent）', () => {
    expect(payStartDecision({ ...BASE, lastChannel: 'wechat' })).toEqual({
      kind: 'start',
      channel: 'stripe',
      retireKey: true,
    });
  });

  it('同一通道再来一次 → 不换键（重试必须还是同一个键，否则同一张单发起两次）', () => {
    expect(payStartDecision({ ...BASE, lastChannel: 'stripe' })).toEqual({
      kind: 'start',
      channel: 'stripe',
      retireKey: false,
    });
  });

  /**
   * B6 / AJ-201：在途守卫。
   * @why 只断言"不发起"是不够的——`ignore` 也可能来自脏输入；
   *      所以同时钉"同样的输入把 paying 换成 false 就能发起"，
   *      证明挡住它的**确实是在途状态**这一条，而不是别的分支顺手拦下。
   */
  it('上一次发起还在途中 → ignore；放掉 paying 就能发起（B6 / AJ-201）', () => {
    expect(payStartDecision({ ...BASE, paying: true })).toEqual({ kind: 'ignore' });
    expect(payStartDecision({ ...BASE, paying: true, channel: 'wechat' }).kind).toBe('ignore');
    expect(payStartDecision({ ...BASE, paying: false }).kind).toBe('start');
  });

  it('脏输入：channel 不是字符串 / 空串 / 键没就绪 → ignore', () => {
    expect(payStartDecision({ ...BASE, channel: undefined }).kind).toBe('ignore');
    expect(payStartDecision({ ...BASE, channel: 42 }).kind).toBe('ignore');
    expect(payStartDecision({ ...BASE, channel: '' }).kind).toBe('ignore');
    expect(payStartDecision({ ...BASE, hasKey: false }).kind).toBe('ignore');
    // 参数整体不是对象也不能炸（wxml 传错形态时页面只是不动）
    expect(payStartDecision(null).kind).toBe('ignore');
    expect(payStartDecision(undefined).kind).toBe('ignore');
  });
});

describe('copyResult（复制短链之后页面该显示什么，B34 / AJ-217）', () => {
  it('成功：按钮改"已复制"，且不带错误（成功时不该留下上一次的失败提示）', () => {
    expect(copyResult(true)).toEqual({ copied: true, error: '' });
  });

  it('失败：给兜底动作，而不是只说"失败"——链接就在屏幕上，长按可选', () => {
    const r = copyResult(false);
    expect(r.copied).toBe(false);
    expect(r.error).toContain('复制失败');
    // ⚠️ 这一句是 B34 的要点：只说"复制失败"等于告诉用户走投无路
    expect(r.error).toContain('长按');
  });

  it('宿主回调给的不是布尔（undefined / null / 字符串）→ 一律当失败，不悄悄当成功', () => {
    for (const ok of [undefined, null, 0, '', 'true']) {
      expect(copyResult(ok).copied, `入参 ${JSON.stringify(ok)}`).toBe(false);
      expect(copyResult(ok).error).toContain('长按');
    }
  });

  it('反向：成功态不能带"复制失败"字样（否则按钮显示"已复制"而上面飘着红字）', () => {
    expect(copyResult(true).error).not.toContain('复制失败');
    expect(copyResult(true).error).toBe('');
  });
});

/**
 * 防复发：B34 的病根在**薄壳**（`onCopy` 当初根本没传回调），vm 单测一条也抓不到——
 * 把 `fail:` 删掉，`copyResult` 的 4 条用例照样全绿。所以这里扫源码钉住"调用真的带回调"。
 *
 * @why 扫描型断言最容易写成自证（§2 第 49 条），且会被**注释里的同款字符串**假绿
 *      （§2 第 54 条）。两条防线：① 先剥掉注释行再扫；② 配自检——
 *      用同一套判定去打一段"删了 fail 的假代码"，必须判为不合格。
 */
describe('防复发：薄壳的剪贴板调用必须带 success 与 fail（B34 / AJ-217）', () => {
  /** 取 `wxApi.setClipboardData({...})` 这一整段调用（到第一个 `});` 为止）。 */
  function clipboardCall(code: string): string {
    const i = code.indexOf('setClipboardData(');
    if (i < 0) return '';
    const end = code.indexOf('});', i);
    return end < 0 ? '' : code.slice(i, end);
  }
  /** 剥注释行（§2 第 54 条：不剥会把"注释里写着 fail"当成实现）。 */
  function stripComments(src: string): string {
    return src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }
  const hasBoth = (code: string): boolean => {
    const call = clipboardCall(code);
    if (call === '') return false;
    if (!call.includes('success:') || !call.includes('fail:')) return false;
    // 光"带了回调"还不够：fail 里若写 copyResult(true)，页面会在复制失败时显示"已复制"——
    // 那正是 B34 要防的形态（看起来成功、实际没写进剪贴板），所以连参数一起钉。
    return call.includes('copyResult(true)') && call.includes('copyResult(false)');
  };

  it('自检一：剥注释真的能剥掉（否则这条断言扫的是注释不是代码）', () => {
    expect(stripComments('// x\nreal\n/* y */\n * z\nreal2').split('\n')).toEqual([
      'real',
      'real2',
    ]);
  });

  it('自检二：判定对"删掉 fail 的版本"必须报不合格（否则它是永真的）', () => {
    const broken = 'wxApi.setClipboardData({\n  data: u,\n  success: () => {},\n});';
    expect(hasBoth(broken), '只带 success 的实现必须被判为不合格').toBe(false);
    // fail 里写成成功态：回调带了、方向反了——同样必须判为不合格
    const inverted =
      'wxApi.setClipboardData({\n  data: u,\n  success: () => copyResult(true),\n  fail: () => copyResult(true),\n});';
    expect(hasBoth(inverted), 'fail 走成功态必须被判为不合格').toBe(false);
    // 反过来：完整的实现判为合格——证明上面两条不是因为"压根没匹配到调用"
    const good =
      'wxApi.setClipboardData({\n  data: u,\n  success: () => copyResult(true),\n  fail: () => copyResult(false),\n});';
    expect(hasBoth(good)).toBe(true);
  });

  it('index.js 里真的带上了 fail（微信支付上线前这是唯一的付款路径）', () => {
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    expect(src.length).toBeGreaterThan(0);
    expect(hasBoth(stripComments(src))).toBe(true);
  });
});

describe('payPageView：这张单还能不能走支付流程（B35 / AJ-218）', () => {
  it('created / pending_payment → 可付，且不显示说明', () => {
    expect(payPageView({ status: 'created' })).toEqual({ payable: true, closedText: '' });
    expect(payPageView({ status: 'pending_payment' })).toEqual({ payable: true, closedText: '' });
  });

  it('已付及之后的每一态 → 不可付，说明里带状态文案（不是空白、也不是英文状态码）', () => {
    for (const s of ['paid', 'shipped', 'delivered', 'completed', 'refunded', 'refunding']) {
      const v = payPageView({ status: s });
      expect(v.payable, s).toBe(false);
      // ⚠️ 反向：不能把英文状态码直接丢给用户（"paid" 在中文界面上是渲染事故）
      expect(v.closedText).not.toContain(s);
      expect(v.closedText.length).toBeGreaterThan(0);
    }
    expect(payPageView({ status: 'paid' }).closedText).toContain('已付款');
  });

  it('已取消 / 已超时关闭：同样不可付（点了是 40902，不是"再付一次就活了"）', () => {
    expect(payPageView({ status: 'cancelled' }).payable).toBe(false);
    expect(payPageView({ status: 'expired' }).payable).toBe(false);
  });

  it('状态读不到 / 认不出 → 按"可付"放行：不能付由服务端 40902 说出来，不由前端静默堵死', () => {
    for (const o of [undefined, null, {}, { status: 42 }, { status: 'some_new_status' }]) {
      expect(payPageView(o).payable, JSON.stringify(o)).toBe(true);
      expect(payPageView(o).closedText).toBe('');
    }
  });
});

describe('onShowAction：回到支付页该做什么（B35 / AJ-218 → AJ-227）', () => {
  it('普通状态（还没发起、没有短链）→ reload（真值在服务端回调里，本页不轮询）', () => {
    expect(onShowAction({ payUrl: '', guideTitle: '', paying: false })).toBe('reload');
    expect(onShowAction({})).toBe('reload');
    // 参数整体不是对象也不能炸
    expect(onShowAction(null)).toBe('reload');
    expect(onShowAction(undefined)).toBe('reload');
  });

  /**
   * ⚠️ 这条的期望值**改了**（原来是"copylink 屏 → 不刷新"）。
   * @why "去浏览器付款"只发生在 copylink 屏；这一屏什么都不做，付完回来就还挂着支付方式，
   *      点了 40902——B35 要修的正是它。现在是 `status`：只查订单，已不可付才收起，
   *      仍可付则短链原样保留（这一半由 index.shell.unit.test.ts 的行为用例验）。
   */
  it('🔴 copylink 屏正在用 → status（只查订单状态，不是 none 也不是 reload）', () => {
    expect(onShowAction({ payUrl: 'https://pay.test/l/abc' })).toBe('status');
  });

  it('任何引导屏（auto / unsupported）→ status：同理', () => {
    expect(onShowAction({ guideTitle: '支付已完成' })).toBe('status');
    expect(onShowAction({ guideTitle: '暂时无法支付' })).toBe('status');
  });

  it('发起支付在途中 → none（再取一次会并发两个"发起"），且优先于其它两条', () => {
    expect(onShowAction({ paying: true })).toBe('none');
    expect(onShowAction({ paying: true, payUrl: 'https://pay.test/l/abc' })).toBe('none');
  });
});

describe('closedScreen：订单已不需要支付时要清掉的全部内容（AJ-227）', () => {
  it('五样一起清：支付方式、提示条、短链、引导、"已复制"', () => {
    expect(closedScreen('该订单已付款，无需再支付')).toEqual({
      closedText: '该订单已付款，无需再支付',
      channels: [],
      notice: [],
      payUrl: '',
      guide: { title: '', body: '', actionText: '' },
      copied: false,
    });
  });

  it('每次返回新的 guide 对象（不把冻结的常量交给 setData）', () => {
    expect(closedScreen('x').guide).not.toBe(EMPTY_GUIDE);
    expect(Object.isFrozen(closedScreen('x').guide)).toBe(false);
  });
});

describe('PAY_FAIL_TEXT：取消与失败统一文案（B35 / AJ-218）', () => {
  it('必须给出下一步，且不出现"加载失败"（把取消说成故障会让人以为钱出问题了）', () => {
    expect(PAY_FAIL_TEXT).toContain('可重新选择支付方式');
    expect(PAY_FAIL_TEXT).not.toContain('加载失败');
    // 也不许出现宿主黑盒字样：那等于把 errMsg 当契约
    expect(PAY_FAIL_TEXT).not.toContain('requestPayment');
  });
});

/**
 * 防复发：B35 的三条修复**全在薄壳**（`requestPayment` 没 success、取数不看状态、
 * 没有 onShow 刷新），vm 的纯函数用例在薄壳漏接线时一条都不会红——
 * 纯函数测不到"有没有人调用它"（与 B34 / AJ-217 同一条理由，形状也照抄）。
 */
describe('防复发：薄壳的三处接线（B35 / AJ-218）', () => {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('自检：剥注释后仍能找到这些调用（否则下面的断言扫的是注释不是代码）', () => {
    expect(code, '自检：剥完注释文件不能是空的').not.toBe('');
    expect(code).not.toContain('wxApi.setClipboardData({ data: this.data.payUrl });');
  });

  it('requestPayment 必须同时带 success 与 fail，且 fail 走 PAY_FAIL_TEXT', () => {
    const i = code.indexOf('requestPayment(');
    expect(i, '自检：index.js 里确实有 requestPayment 调用').toBeGreaterThan(-1);
    const call = code.slice(i, code.indexOf('});', i));
    expect(call).toContain('success:');
    expect(call).toContain('fail:');
    // ⚠️ fail 里若仍走 errorMessage，取消支付会显示宿主黑盒文案——B35 要防的正是这个
    expect(call).toContain('PAY_FAIL_TEXT');
    expect(call).not.toContain('errorMessage');
  });

  it('取数必须用 payPageView 决定"要不要列通道"；onShow 必须走 onShowAction', () => {
    // @why 这两条是"接线存在性"的下限：漏接的表现是页面静默回到 B35 之前的行为，
    //      而所有纯函数用例仍然全绿。
    expect(code).toContain('payPageView(');
    expect(code).toContain('onShowAction(');
  });
});
