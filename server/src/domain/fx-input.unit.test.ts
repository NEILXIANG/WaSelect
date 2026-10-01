/**
 * 职责：`domain/fx-input.ts` 的单测（I2 U-C1）。
 *
 * @why 每个约束都给「错值」与「对值」两个用例（CLAUDE.md 七项完成标准）：
 *      只测通过值的话，"把校验整段删掉"也能绿——校验的存在性必须由
 *      "某个值被拒绝"来证明，而不是由"某个值被接受"来证明。
 *
 * @why `applyFxBuffer` 的结果直接对 `toRateInt` 做交叉验证：
 *      本函数的产出**只**被 toRateInt 消费（domain/quote.ts 经它算展示价）。
 *      两个模块各测各的，接缝处谁也不管——而接缝正是"两次舍入"会出错的地方。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { applyFxBuffer, FX_QUOTES, parseFxInput } from './fx-input.js';
import { FX_RAW_RATE_BOUNDS, toRateInt } from '@waselect/shared';

/** 取错误码（非 AppError 直接抛出，避免"没抛错也绿"）。 */
function codeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  throw new Error('预期抛 AppError，实际没有抛');
}

/** 取 `details.reason`（越界的两种录入错误要能分开报，只断言"被拒"证明不了）。 */
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return String((e.details as { reason?: unknown })?.reason ?? '');
    throw e;
  }
  throw new Error('预期抛 AppError，实际没有抛');
}

/** 各币种的量纲区间与"真实汇率 / 错一位"的对照（AJ-297）。 */
const FX_CASES: Array<{ quote: string; real: number }> = [
  { quote: 'USD', real: 0.0067 }, // 1 USD ≈ 149 JPY
  { quote: 'CNY', real: 0.049 }, // 1 CNY ≈ 20 JPY
];

describe('parseFxInput', () => {
  it('body 不是对象 → 40001', () => {
    expect(codeOf(() => parseFxInput(null))).toBe(40001);
    expect(codeOf(() => parseFxInput('x'))).toBe(40001);
  });

  it('quote 缺失或不在枚举内 → 40001（JPY 是定价锚，没有展示汇率入口）', () => {
    expect(codeOf(() => parseFxInput({ raw_rate: 0.0065 }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'JPY', raw_rate: 1 }))).toBe(40001);
    // 小写不放松：enum 是契约面的事实，大小写变异等于新增一个未登记的值
    expect(codeOf(() => parseFxInput({ quote: 'usd', raw_rate: 0.0065 }))).toBe(40001);
  });

  it('raw_rate 缺失 / 非有限数 / ≤0 → 40001', () => {
    expect(codeOf(() => parseFxInput({ quote: 'USD' }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: '0.0065' }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: Number.NaN }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: 0 }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: -0.0065 }))).toBe(40001);
  });

  /**
   * AJ-297：量纲区间是 **per-quote** 的，10 倍的"错一位"必然越界。
   *
   * @why 区间按币种分开取这件事本身就是本条要证明的东西：过去两端都写
   *      "绝对值没有合理范围（0.0067 和 0.049 都是对的）"，那句话把"跨币种没有统一区间"
   *      错当成了"每个币种都没有区间"——这里用**同一个数字在两个币种下结论相反**钉住它：
   *      0.0067 在 USD 收、在 CNY 拒；0.049 在 CNY 收、在 USD 拒。
   * @why 只测"通过值"证明不了护栏存在（把整段删掉也全绿），所以每个币种都必须有
   *      **被拒**的值，且被拒的值要取"真实汇率 ×10 / ÷10"——即真实会发生的录入错误。
   */
  it('🔴 per-quote 量纲区间：真实汇率照收，错一位（×10 / ÷10）一律拒（AJ-297）', () => {
    for (const c of FX_CASES) {
      expect(parseFxInput({ quote: c.quote, raw_rate: c.real }).rawRate).toBe(c.real);
      expect(
        codeOf(() => parseFxInput({ quote: c.quote, raw_rate: c.real * 10 })),
        `${c.quote} 多打一位（${c.real * 10}）必须被拦`,
      ).toBe(40001);
      expect(
        codeOf(() => parseFxInput({ quote: c.quote, raw_rate: c.real / 10 })),
        `${c.quote} 少打一位（${c.real / 10}）必须被拦`,
      ).toBe(40001);
    }
    // 同一个数字在两个币种下结论相反——这是"区间必须 per-quote"的直接证据
    expect(codeOf(() => parseFxInput({ quote: 'CNY', raw_rate: 0.0067 }))).toBe(40001);
    expect(parseFxInput({ quote: 'USD', raw_rate: 0.0067 }).rawRate).toBe(0.0067);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: 0.049 }))).toBe(40001);
    expect(parseFxInput({ quote: 'CNY', raw_rate: 0.049 }).rawRate).toBe(0.049);
  });

  it('区间**边界含在内**：min / max 本身放行（不能把极值本身拦掉）', () => {
    for (const q of FX_QUOTES) {
      const b = FX_RAW_RATE_BOUNDS[q];
      expect(parseFxInput({ quote: q, raw_rate: b.min }).rawRate).toBe(b.min);
      expect(parseFxInput({ quote: q, raw_rate: b.max }).rawRate).toBe(b.max);
      // 越一点点就拒
      expect(codeOf(() => parseFxInput({ quote: q, raw_rate: b.max * 1.001 }))).toBe(40001);
      expect(codeOf(() => parseFxInput({ quote: q, raw_rate: b.min * 0.999 }))).toBe(40001);
    }
  });

  it('越界报 `raw_rate_magnitude`，detail 带币种与区间（运营要能自己核对"哪个币、该在多少之间"）', () => {
    const d = (() => {
      try {
        parseFxInput({ quote: 'USD', raw_rate: 0.067 });
      } catch (e) {
        return ((e as AppError).details ?? {}) as Record<string, unknown>;
      }
      return {};
    })();
    expect(d['reason']).toBe('raw_rate_magnitude');
    expect(d['quote']).toBe('USD');
    expect(d['min']).toBe(FX_RAW_RATE_BOUNDS.USD.min);
    expect(d['max']).toBe(FX_RAW_RATE_BOUNDS.USD.max);
  });

  /**
   * 🔴 旧的两个分支（`> 1000` 与 `< 5e-9`）被删掉了——本用例证明**删得对**：
   * 新区间必须完全落在旧区间内部，且区间内任意值都不会让 rate 被网格舍成 0。
   *
   * @why 直接删掉旧用例、新增例，看上去一样绿；但"新护栏真的覆盖了旧护栏"
   *      是另一件事——少了这一条，将来有人把区间放宽到 1000 以上或收到 1e-9 以下，
   *      旧的 `toRateInt(0)` 那条 500 链就会**复活**而没有任何用例报警。
   */
  it('🔴 被删掉的旧上界（1000）与旧下界（5e-9）确实不可达：新区间完全覆盖旧护栏', () => {
    for (const q of FX_QUOTES) {
      const b = FX_RAW_RATE_BOUNDS[q];
      expect(b.max).toBeLessThanOrEqual(1000); // 旧 MAX_RAW_RATE 分支不可达
      expect(b.min).toBeGreaterThan(0.5 / 1e8); // 旧 MIN_RAW_RATE 分支不可达
      // 区间下界经过 buffer=0 的对齐后仍 > 0 ⇒ toRateInt 不会抛（B25 / AJ-211 那条链）
      expect(toRateInt(applyFxBuffer(b.min, 0))).toBeGreaterThan(0);
      expect(reasonOf(() => parseFxInput({ quote: q, raw_rate: 1e-12 }))).toBe(
        'raw_rate_magnitude',
      );
    }
  });

  it('effective_from 非法日期 → 40001；缺省 → null（调用方填 clock.now()）', () => {
    expect(
      codeOf(() => parseFxInput({ quote: 'USD', raw_rate: 0.0065, effective_from: 'x' })),
    ).toBe(40001);
    expect(parseFxInput({ quote: 'USD', raw_rate: 0.0065 }).effectiveFromMs).toBeNull();
  });

  /**
   * 🔴 DOM3-03：不带偏移的串"看起来合法"，而 `Date.parse` 会按**进程时区**解释它——
   * 本机（JST）与生产（UTC）差 8 小时，同一个请求落库两个时刻。
   */
  it('🔴 effective_from 不带偏移 → 40001（时区歧义不得由服务端猜，DOM3-03）', () => {
    for (const raw of ['2026-10-01T00:00', '2026-10-01T00:00:00', '2026/10/01', '1']) {
      expect(
        codeOf(() => parseFxInput({ quote: 'USD', raw_rate: 0.0065, effective_from: raw })),
      ).toBe(40001);
    }
    // 带偏移的同样时刻仍然收（前端自己发的就是 +09:00）
    expect(
      parseFxInput({
        quote: 'USD',
        raw_rate: 0.0065,
        effective_from: '2026-10-01T00:00:00+09:00',
      }).effectiveFromMs,
    ).toBe(Date.parse('2026-09-30T15:00:00Z'));
  });

  it('合法输入：两币都收，effective_from 解析成 UTC 毫秒（带偏移也归一）', () => {
    const expectMs = Date.parse('2026-09-28T00:00:00Z');
    // ⚠️ 两个币种的 raw_rate **不能**用同一个数（AJ-297）：0.0065 是 USD 的量级，
    //    填到 CNY 上会被量纲区间拒——这条用例过去用同一个 0.0065 跑两个币，
    //    正是"跨币种没有区间"那个错误认知留下的痕迹。
    const perQuote: Record<string, number> = { USD: 0.0065, CNY: 0.048 };
    for (const q of FX_QUOTES) {
      const v = parseFxInput({
        quote: q,
        raw_rate: perQuote[q] as number,
        effective_from: '2026-09-28T00:00:00Z',
      });
      expect(v.quote).toBe(q);
      expect(v.effectiveFromMs).toBe(expectMs);
    }
    // JST 同一时刻：前端 toIsoJst 钉成 +09:00，两种写法必须落到同一毫秒
    expect(
      parseFxInput({
        quote: 'USD',
        raw_rate: 0.0065,
        effective_from: '2026-09-28T09:00:00+09:00',
      }).effectiveFromMs,
    ).toBe(expectMs);
  });
});

describe('applyFxBuffer', () => {
  it('rate = raw × (1 + buffer)', () => {
    expect(applyFxBuffer(0.0065, 0.03)).toBe(0.006695);
    expect(applyFxBuffer(100, 0)).toBe(100);
  });

  it('结果落在 1e-8 网格上：与 toRateInt 的舍入只发生一次', () => {
    // 0.0065 × 1.03 在 double 里带浮点尾巴；不先对齐的话 rate 与 rateInt 会各自舍入一次
    const rate = applyFxBuffer(0.0065, 0.03);
    expect(rate * 1e8).toBe(Math.round(rate * 1e8));
    expect(toRateInt(rate)).toBe(669500);
  });
});

/**
 * `FX_QUOTES` 与契约 `POST /admin/fx` 请求体 `quote` 的 enum 集合相等（第三轮审查 DOM3-01）。
 * @why fx-input.ts 的注释原来就写着"单测与契约双向比对"，但全仓没有任何比对——
 *      给 FX_QUOTES 加一个 EUR，测试照样全绿，服务端接受契约外的币种。
 */
describe('FX_QUOTES 与契约的双向比对（DOM3-01）', () => {
  const yaml = readFileSync(
    resolve(import.meta.dirname, '../../../contracts/api-contract.yaml'),
    'utf8',
  );
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => /^ {2}\/admin\/fx:\s*$/.test(l));
  const body =
    lines.slice(at, at + 20).find((l) => l.includes('requestBody:') && l.includes('quote:')) ?? '';

  it('抽到了 /admin/fx 的请求体行', () => {
    expect(at).toBeGreaterThan(0);
    expect(body).toContain('raw_rate');
  });

  it('集合完全相等', () => {
    const m = /quote:\s*\{type:\s*string,\s*enum:\s*\[([^\]]+)\]/.exec(body);
    const inContract = (m?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(inContract).toEqual([...FX_QUOTES]);
  });
});
