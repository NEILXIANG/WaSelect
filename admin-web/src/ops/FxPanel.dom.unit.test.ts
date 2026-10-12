// @vitest-environment jsdom
/**
 * 职责：汇率面板的**组件行为**用例——"保存前核对"这道闸到底拦不拦得住（A8 残留 / AJ-229）。
 *
 * @why 展示汇率直接乘进美元实扣额。A8（AJ-186）加了量级核对，但核对逻辑的**接线**在 `.tsx` 里，
 *      当时没有组件测试环境，留下四个洞，全部是纯函数用例测不到的：
 *        ① 基准取错：`GET /admin/fx` 返回全部历史与未来行，面板逐行覆盖，留下的是每个币种**最早**的一行；
 *        ② 取不到当前汇率（首次配置 / 加载失败）时不核对，一点即存；
 *        ③ 进入确认态后改值或换币种，勾选不复位，保存时也不再校验；
 *        ④ 不可疑的值（倍数在 0.67–1.5 之间）一键保存，没有任何确认。
 *
 * ⚠️ **2026-10-02（AJ-297）大批"可疑值"被换了**：本文件原来大量用 `0.67` / `150` / `67`
 *      这类数当"录错的值"——它们现在会被 `fxFormErrors` 的 **per-quote 量纲区间**先拒掉，
 *      面板直接显示错误、**根本进不到确认态**，于是下面这些 `ackBox(el)` 全是 null ⇒ 用例红。
 *      改法不是"放宽断言"，而是**换成仍在区间内的可疑值**（0.0134 = 当前的 2 倍）：
 *      `fxFormErrors` 管量纲（错一位）、`fxSaveStep` 管相对跳变，**两层各管各的**；
 *      用越界值去测第二层，等于在测一个永远走不到的路径。
 *      ⚠️ 顺带：两条 fixture 里"当初录错的历史行"（0.67）也改成了 0.0134——
 *      0.67 在新护栏下**永远存不进去**，fixture 描述的是一个不可能再出现的状态。
 *
 * @see ./FxPanel.tsx；./view.ts（`currentFxRawRates` / `fxSaveStep`）；../testing/dom.ts
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, flush, mount, type, type Mounted } from '../testing/dom.js';
import { FxPanel } from './FxPanel.js';

interface Call {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
}

let mounted: Mounted | undefined;
let calls: Call[];
/** 不为 null 时，POST 会挂在这个 promise 上（模拟"第一笔还没回来"）。 */
let holdPost: Promise<void> | null = null;

/**
 * 服务端的真实形状：全部行，`quote asc, effective_from desc`（含历史与未来），
 * 每行带服务端按自己时钟判定的 `is_current`（ADM3-05）。
 */
const HISTORY = [
  // 未来才生效的一行（已录入、尚未生效）
  {
    quote: 'USD',
    raw_rate: 0.0071,
    buffer: 0.03,
    rate: 0.007313,
    effective_from: '2099-01-01T00:00:00.000Z',
    is_current: false,
  },
  // 当前生效
  {
    quote: 'USD',
    raw_rate: 0.0067,
    buffer: 0.03,
    rate: 0.006901,
    effective_from: '2026-09-20T00:00:00.000Z',
    is_current: true,
  },
  // 最早的一行：当初录错了（2 倍），后来被上面那行更正
  {
    quote: 'USD',
    raw_rate: 0.0134,
    buffer: 0.03,
    rate: 0.013802,
    effective_from: '2026-09-01T00:00:00.000Z',
    is_current: false,
  },
];

async function open(opts: { list?: unknown; listFails?: boolean } = {}): Promise<HTMLElement> {
  calls = [];
  holdPost = null;
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    if (req.method === 'POST') {
      if (holdPost !== null) await holdPost;
      return {};
    }
    if (opts.listFails === true) throw new Error('network down');
    return opts.list ?? HISTORY;
  };
  mounted = await mount(createElement(FxPanel, { api: api as never }));
  // 表单默认币种是 CNY；本组用例的历史数据都是 USD
  await type(mounted.el.querySelector('select'), 'USD');
  return mounted.el;
}

const posts = (): Call[] => calls.filter((c) => c.method === 'POST');
const rateInput = (el: HTMLElement): HTMLInputElement | null =>
  el.querySelector('input[placeholder^="原始汇率"]');
const ackBox = (el: HTMLElement): HTMLInputElement | null =>
  el.querySelector('input[type="checkbox"]');
const confirmButton = (el: HTMLElement): HTMLButtonElement | null =>
  [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith('确认保存')) ??
  null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('汇率面板：保存前核对（A8 残留 / AJ-229）', () => {
  it('🔴 基准是**当前生效**那一行（不是最早的、也不是未来的）：录 0.67 必须标可疑', async () => {
    const el = await open();
    await type(rateInput(el), '0.0134'); // 与最早那行（录错的）相同，与当前生效值差 2 倍
    expect(el.textContent).toContain('请确认不是小数点错位');
    await click(button(el, '保存汇率'));
    expect(posts()).toHaveLength(0); // 没有直接提交
    expect(ackBox(el)).not.toBeNull(); // 要勾选
  });

  it('🔴 接近当前值的正常调整：不标可疑，但仍要点一次确认才提交（一键保存不存在）', async () => {
    const el = await open();
    await type(rateInput(el), '0.0068');
    expect(el.textContent).not.toContain('小数点错位');
    await click(button(el, '保存汇率'));
    expect(posts()).toHaveLength(0);
    expect(ackBox(el)).toBeNull(); // 不可疑 → 不要求勾选
    await click(confirmButton(el));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toMatchObject({ quote: 'USD', raw_rate: 0.0068 });
  });

  it('🔴 取不到当前汇率（加载失败）：不能当成"没问题"，必须勾选确认', async () => {
    const el = await open({ listFails: true });
    await type(rateInput(el), '0.0067'); // 值本身正常；本例要的是"没有基准"这件事
    await click(button(el, '保存汇率'));
    expect(posts()).toHaveLength(0);
    expect(ackBox(el)).not.toBeNull();
    expect(confirmButton(el)?.disabled).toBe(true);
  });

  it('🔴 首次配置（一行都没有）：同样必须勾选确认', async () => {
    const el = await open({ list: [] });
    await type(rateInput(el), '0.0067');
    await click(button(el, '保存汇率'));
    expect(posts()).toHaveLength(0);
    expect(ackBox(el)).not.toBeNull();
  });

  it('🔴 勾选之后再改值：确认作废，必须对**新值**重新走一遍', async () => {
    const el = await open();
    await type(rateInput(el), '0.0134');
    await click(button(el, '保存汇率'));
    await click(ackBox(el));
    expect(confirmButton(el)?.disabled).toBe(false);

    await type(rateInput(el), '0.02'); // 勾完再改成另一个值（仍在量纲区间内）
    // 确认态必须已经退出：屏幕上不应还有一个可点的"确认保存"
    expect(confirmButton(el)).toBeNull();
    expect(posts()).toHaveLength(0);
    await click(button(el, '保存汇率'));
    expect(ackBox(el)?.checked).toBe(false);
    expect(confirmButton(el)?.disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('可疑值：勾选并确认后才提交，提交的是屏幕上核对过的那个值', async () => {
    const el = await open();
    await type(rateInput(el), '0.0134'); // 2 倍
    await click(button(el, '保存汇率'));
    await click(ackBox(el));
    await click(confirmButton(el));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toMatchObject({ quote: 'USD', raw_rate: 0.0134 });
  });

  it('形状不合法（空 / 超上界）：点保存只报错，不进确认态、不提交', async () => {
    const el = await open();
    await type(rateInput(el), '1001');
    await click(button(el, '保存汇率'));
    expect(posts()).toHaveLength(0);
    expect(confirmButton(el)).toBeNull();
    // 规律排查 2026-10-12：填写错误改为标在按钮旁（原先走浮层；只换选择器，断言强度不变）
    expect(el.querySelector('section [role="alert"]')?.textContent ?? '').not.toBe('');
  });
});

describe('汇率面板：当前生效行由服务端标（ADM3-05）', () => {
  /** 本机时钟比服务端慢：服务端说"2099 那行已生效"，本机看它是未来行。 */
  const CLOCK_SKEW = [
    {
      quote: 'USD',
      raw_rate: 0.0067,
      buffer: 0.03,
      rate: 0.006901,
      effective_from: '2099-01-01T00:00:00.000Z',
      is_current: true, // 服务端标的当前生效行
    },
    {
      quote: 'USD',
      raw_rate: 0.0134,
      buffer: 0.03,
      rate: 0.013802,
      effective_from: '2026-09-01T00:00:00.000Z',
      is_current: false,
    },
  ];

  it('🔴 基准取服务端标的那一行：按它微调（0.0068）**不标可疑**，也不要求勾选', async () => {
    // 旧实现拿本机时钟把 2099 那行当未来行排除 → 基准变成 0.0134 → 0.0068 是它的 1/2 → 标可疑
    const el = await open({ list: CLOCK_SKEW });
    await type(rateInput(el), '0.0068');
    expect(el.textContent).not.toContain('小数点错位');
    await click(button(el, '保存汇率'));
    expect(ackBox(el)).toBeNull();
    await click(confirmButton(el));
    expect(posts()).toHaveLength(1);
  });

  it('列表标出"当前生效"行（运营不用靠生效时间去推）', async () => {
    const el = await open({ list: CLOCK_SKEW });
    const cells = [...el.querySelectorAll('tbody td')].map((td) => td.textContent ?? '');
    expect(cells.filter((t) => t.includes('当前生效'))).toHaveLength(1);
    expect(cells.some((t) => t.includes('2099-01-01') && t.includes('当前生效'))).toBe(true);
  });
});

describe('汇率面板：勾选可以被撤回（ADM3-03）', () => {
  it('🔴 勾选之后复选框**仍在**且仍是勾选态（旧实现勾完就把它卸载了）', async () => {
    const el = await open();
    await type(rateInput(el), '0.0134');
    await click(button(el, '保存汇率'));
    await click(ackBox(el));
    expect(ackBox(el)).not.toBeNull(); // 没有被卸载
    expect(ackBox(el)?.checked).toBe(true);
    expect(confirmButton(el)?.disabled).toBe(false);
  });

  it('🔴 再点一次可撤回 → 确认按钮重新禁用（运营改主意想再核对一遍时找得到它）', async () => {
    const el = await open();
    await type(rateInput(el), '0.0134');
    await click(button(el, '保存汇率'));
    await click(ackBox(el));
    await click(ackBox(el));
    expect(ackBox(el)?.checked).toBe(false);
    expect(confirmButton(el)?.disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('不可疑的值：全程不出现复选框（不是"每次都勾"）', async () => {
    const el = await open();
    await type(rateInput(el), '0.0068');
    await click(button(el, '保存汇率'));
    expect(ackBox(el)).toBeNull();
    await click(confirmButton(el));
    expect(ackBox(el)).toBeNull();
    expect(posts()).toHaveLength(1);
  });
});

describe('汇率面板：重复 key 与重复提交（ADM3-04）', () => {
  /** 同一分钟内录两次的两行（留空生效时间 → 服务端按毫秒取当前时刻）。 */
  const SAME_MINUTE = [
    {
      quote: 'USD',
      raw_rate: 0.0067,
      buffer: 0.03,
      rate: 0.006901,
      effective_from: '2026-10-01T03:10:41.900Z',
      is_current: true,
    },
    {
      quote: 'USD',
      raw_rate: 0.0068,
      buffer: 0.03,
      rate: 0.007,
      effective_from: '2026-10-01T03:10:12.100Z',
      is_current: false,
    },
  ];

  it('🔴 同一分钟两行同时渲染：console.error 里不得出现 "same key"', async () => {
    const errs: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errs.push(args);
    };
    try {
      await open({ list: SAME_MINUTE });
    } finally {
      console.error = orig;
    }
    const joined = JSON.stringify(errs);
    expect(joined).not.toContain('same key');
    expect(joined).not.toContain('duplicate key');
  });

  it('🔴 第一笔 POST 还没回来时再点"确认保存"，POST 仍只有 1 个', async () => {
    let release: (() => void) | undefined;
    const el = await open();
    holdPost = new Promise<void>((r) => {
      release = r;
    });
    await type(rateInput(el), '0.0068');
    await click(button(el, '保存汇率'));
    await click(confirmButton(el));
    // 此刻第一笔还没回来：按钮应已禁用且文案变成"保存中…"
    const busy = [...el.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('保存中'),
    );
    expect(busy).toBeDefined();
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await click(busy); // 禁用按钮的 click 不触发 onClick；且 attempt 里还有一道 if (saving)
    expect(posts()).toHaveLength(1);
    // ⚠️ 放行的那次状态更新也要包在 act 里（否则 React 会告警"update not wrapped in act"）
    release?.();
    await flush();
  });
});

// 规律排查 2026-10-12：汇率没填 / 填错就点「保存汇率」——提示只进浮层，输入框旁边什么都没有
describe('汇率面板：填写错误就近说', () => {
  it('🔴 原始汇率空着点保存 → 按钮旁出提示；改了输入提示消失', async () => {
    const el = await open();
    await click(button(el, '保存汇率'));
    const alert = el.querySelector('section [role="alert"]');
    expect(alert?.textContent ?? '').not.toBe('');
    expect(posts()).toHaveLength(0);
    await type(rateInput(el), '0.0068');
    expect(el.querySelector('section [role="alert"]')).toBeNull();
  });
});
