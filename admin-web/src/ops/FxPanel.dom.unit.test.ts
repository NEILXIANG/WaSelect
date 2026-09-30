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
 * @see ./FxPanel.tsx；./view.ts（`currentFxRawRates` / `fxSaveStep`）；../testing/dom.ts
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { FxPanel } from './FxPanel.js';

interface Call {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
}

let mounted: Mounted | undefined;
let calls: Call[];

/** 服务端的真实形状：全部行，`quote asc, effective_from desc`（含历史与未来）。 */
const HISTORY = [
  // 未来才生效的一行（已录入、尚未生效）
  {
    quote: 'USD',
    raw_rate: 0.0071,
    buffer: 0.03,
    rate: 0.007313,
    effective_from: '2099-01-01T00:00:00.000Z',
  },
  // 当前生效
  {
    quote: 'USD',
    raw_rate: 0.0067,
    buffer: 0.03,
    rate: 0.006901,
    effective_from: '2026-09-20T00:00:00.000Z',
  },
  // 最早的一行：当初录错了（多了两个 0 的反方向），后来被上面那行更正
  {
    quote: 'USD',
    raw_rate: 0.67,
    buffer: 0.03,
    rate: 0.6901,
    effective_from: '2026-09-01T00:00:00.000Z',
  },
];

async function open(opts: { list?: unknown; listFails?: boolean } = {}): Promise<HTMLElement> {
  calls = [];
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    if (req.method === 'POST') return {};
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
    await type(rateInput(el), '0.67'); // 与最早那行（录错的）相同，与当前生效值差 100 倍
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
    await type(rateInput(el), '150'); // 典型的"反着填"
    await click(button(el, '保存汇率'));
    expect(posts()).toHaveLength(0);
    expect(ackBox(el)).not.toBeNull();
    expect(confirmButton(el)?.disabled).toBe(true);
  });

  it('🔴 首次配置（一行都没有）：同样必须勾选确认', async () => {
    const el = await open({ list: [] });
    await type(rateInput(el), '150');
    await click(button(el, '保存汇率'));
    expect(posts()).toHaveLength(0);
    expect(ackBox(el)).not.toBeNull();
  });

  it('🔴 勾选之后再改值：确认作废，必须对**新值**重新走一遍', async () => {
    const el = await open();
    await type(rateInput(el), '0.67');
    await click(button(el, '保存汇率'));
    await click(ackBox(el));
    expect(confirmButton(el)?.disabled).toBe(false);

    await type(rateInput(el), '67'); // 勾完再改成另一个量级
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
    expect(el.querySelector('.error')).not.toBeNull();
  });
});
