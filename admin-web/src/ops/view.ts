/**
 * 职责：运营配置的**视图纯函数**（运费分档表 / 展示汇率）。
 *
 * @why 这两张表是**静默出错的重灾区**：运费档位填错一个数，表现不是报错，
 *      而是"每一单都少收钱"（D-46：向下取档曾让每单少收 900–1,000 円且不报错）；
 *      汇率填错一个数，表现是"所有展示价都偏了"，同样没人会报错。
 *      所以前端要在保存前把"能判断的形状问题"全部拦下来。
 *
 * 🔴 **刻意不做"输入重量试算运费"**：
 *      那会在仓库里造出**第二份取档实现**（`>=` + 升序取第一条）。
 *      D-46 的整条教训就是"方向错了还静默"，两份实现迟早漂移，
 *      而漂移发生时前端试算与真实扣款不一致——**比没有试算更危险**（运营会信它）。
 *      要试算就由服务端加接口（取档 SQL 全仓库只允许 `adapters/catalog.ts` 那一份）。
 *
 * @limitation 一：`PUT /admin/shipping-rates` 是**整表替换**（契约明文），
 *              所以校验必须**整表**做：单条看起来合法、整表有重复档位或空洞，
 *              保存后就是"某些重量取不到档"——而这在 UI 上没有任何提示。
 * @limitation 二：`active=false` 的档位在**取档时被跳过**（服务端 SQL 带 `active = true`），
 *              本层只原样展示与提交，不替运营判断"该不该停用"。
 *
 * @see ../../../contracts/api-contract.yaml（ShippingRate / FxRate）；
 *      ../format.ts（展示格式）；server/src/adapters/catalog.ts（D-46 取档唯一实现）
 */
import { FX_RAW_RATE_BOUNDS, SHIPPING_RATE_BOUNDS } from '@waselect/shared';
import { formatJst, halfWidth, moneyText, toIsoJst } from '../format.js';

/** 一条运费分档（表单态：数值以字符串存，提交时转）。 */
export interface RateRow {
  carrier: string;
  maxWeightG: string;
  priceJpy: string;
  active: boolean;
}

/** 一条展示汇率（表单态）。 */
export interface FxForm {
  quote: string;
  rawRate: string;
  effectiveFrom: string;
}

/** 契约 `POST /admin/fx` 的 quote 枚举（单测与契约双向比对）。 */
export const FX_QUOTES = ['CNY', 'USD'] as const;
export type FxQuote = (typeof FX_QUOTES)[number];

export function emptyFxForm(): FxForm {
  return { quote: FX_QUOTES[0], rawRate: '', effectiveFrom: '' };
}

/** 汇率列表行（展示用）。 */
export interface FxRow {
  /**
   * React 列表的 `key`（ADM3-04）。
   * @why 曾经用 `${quote}|${effectiveText}`，而 `effectiveText` 只精确到**分钟**：
   *      留空生效时间时服务端按毫秒取当前时刻，同一币种在同一分钟内保存两次，
   *      两行的展示文本完全相同 → React 报 duplicate key，刷新时行可能被复用错位或丢失。
   *      汇率表是"只能追加"的审计视图，显示错位会让人判断错哪一行是当前生效的。
   * @why 用**原始** `effective_from` + `raw_rate` 而不是展示文本：前者是毫秒级 ISO，
   *      后者被 `formatJst` 抹掉了秒以下。库里 `UNIQUE(quote, effective_from)` 保证
   *      这两项的组合在同一币种下不重复。
   */
  key: string;
  quote: string;
  rateText: string;
  rawRateText: string;
  bufferText: string;
  /** 「100 日元 ≈ 5.10 元」：运营看汇率时最直接的核对方式（三端模拟测试 2026-10-11：0.050985 读不出是多少）。 */
  exampleText: string;
  effectiveText: string;
  /**
   * 服务端判定的"这一行当前已生效"（ADM3-05）。
   * @why 面板曾经用**浏览器时钟**与 `effective_from` 比，而"立即生效"的时刻是服务端打的：
   *      管理员电脑慢几分钟，刚保存的那行被当成"尚未生效"，量级核对的基准回退到上一条。
   *      现在只转述服务端下发的 `is_current`，前端不再有第二份判定。
   */
  isCurrent: boolean;
  /**
   * 当前行的说明：何时要更新 / 已过期（规律排查 2026-10-12：过期的汇率报价与下单当它缺失、整店下不了单，
   * 原先照样写"当前生效"）。取服务端的 `stale_at` / `stale`（0.6.89）；非当前行为空。
   */
  currentNote: string;
  /** 服务端判定已过期（标红用）。 */
  stale: boolean;
}

/** `FxRate[]` → 列表行（未知 quote 原样显示，不猜）。 */
export function fxRows(items: unknown): FxRow[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => {
      const quote = typeof x['quote'] === 'string' ? x['quote'] : '—';
      const rawEffective =
        typeof x['effective_from'] === 'string' ? x['effective_from'] : String(x['effective_from']);
      return {
        key: `${quote}|${rawEffective}|${String(x['raw_rate'])}`,
        quote,
        rateText: num(x['rate']),
        rawRateText: num(x['raw_rate']),
        bufferText: percent(x['buffer']),
        exampleText: example(quote, x['rate']),
        effectiveText: formatJst(x['effective_from']),
        isCurrent: x['is_current'] === true,
        currentNote: currentNote(x),
        stale: x['is_current'] === true && x['stale'] === true,
      };
    });
}

function currentNote(x: Record<string, unknown>): string {
  if (x['is_current'] !== true) return '';
  if (x['stale'] === true) return '（已过期：买家现在下不了单，请立即录入新汇率）';
  return typeof x['stale_at'] === 'string'
    ? `（当前生效 · ${formatJst(x['stale_at'])} 前要更新）`
    : '（当前生效）';
}

/** 0.03 → `3%`（与设置页同口径；三端模拟测试 2026-10-11：这里原写 0.03、设置页写 3%）。 */
function percent(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v)
    ? `${String(Math.round(v * 10000) / 100)}%`
    : '—';
}

/**
 * 100 日元按生效汇率折成多少（两位小数）。美元写 `$0.66`；人民币写 `5.10 元`（日元店里 ¥ 会被读成日元）；
 * 认不出的币种把代码写在后面，不猜符号。
 */
function example(quote: string, rate: unknown): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  const v = (rate * 100).toFixed(2);
  if (quote === 'USD') return `100 日元 ≈ $${v}`;
  if (quote === 'CNY') return `100 日元 ≈ ${v} 元`;
  return `100 日元 ≈ ${v} ${quote}`;
}

function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
}

/**
 * 汇率文本框的值 → 数（唯一入口：`fxFormErrors` / `fxPreview` / `toFxBody` 三处共用）。
 *
 * @why 先 **NFKC 归一**再 `Number()`（复用 `format.ts` 的 `halfWidth`，与分类排序、Banner 排序、
 *      运费分档、列表改库存同一做法）：汇率框是**普通文本框**（`FxPanel.tsx` 的 `<input className="input">`，
 *      没有 `type="number"`，因为要允许小数点），中文输入法全角模式打出的 `０.００６７` 能原样进来，
 *      而 `Number('０.００６７')` 是 `NaN` ⇒ 运营看到的提示是"原始汇率必须是大于 0 的数字"，
 *      可他确实填了数字——**同一类漏网第三次**（2593097 修了排序 / 库存，三天提交复查补了运费表）。
 * @why 归一放在解析处而不是输入框的 onChange：三处解析必须得到同一个数，否则"预览的样例金额"
 *      与"提交上去的 raw_rate"可能不是一件事（那是这一栏存在的意义）。
 * @limitation 只做 NFKC + trim；千分位 `1,000` 与科学计数法仍拒（汇率是小数量级，不需要）。
 */
function rawRateNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return Number.NaN;
  const t = halfWidth(v);
  return t === '' ? Number.NaN : Number(t);
}

/**
 * 汇率表单校验。
 * @why raw_rate 要求 **> 0 的有限数**：0 或负数会让展示价变成 0 或负数，
 *      而契约只说 `type: number`——服务端不会替我们挡住 0。
 */
export function fxFormErrors(form: unknown): { ok: boolean; first: string } {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const quote = typeof f['quote'] === 'string' ? f['quote'] : '';
  const raw = rawRateNumber(f['rawRate']);
  const from = typeof f['effectiveFrom'] === 'string' ? f['effectiveFrom'] : '';
  if (!(FX_QUOTES as readonly string[]).includes(quote))
    return { ok: false, first: '币种必须是 CNY 或 USD' };
  if (!Number.isFinite(raw) || raw <= 0) return { ok: false, first: '原始汇率必须是大于 0 的数字' };
  // ⚠️ 量纲区间与服务端 `domain/fx-input.ts` **同源**（都引 `FX_RAW_RATE_BOUNDS`，AJ-297）：
  //    前端不补这一条的话，"错一位"要等提交之后才被服务端 40001 拒，
  //    而运营看到的是泛化的"参数缺失或格式错误"。
  //    ✅ 现在区间是 per-quote 的，0.067（USD 错一位）在输入时就报，不用等提交。
  const bounds = FX_RAW_RATE_BOUNDS[quote as FxQuote];
  if (raw < bounds.min || raw > bounds.max)
    return {
      ok: false,
      first: `${quote} 的汇率应在 ${bounds.min}–${bounds.max} 之间（1 日元换 ${quote} 的数；你填的是 ${raw}，请检查小数点或币种）`,
    };
  if (from !== '' && toIsoJst(from) === '')
    // 人话（两端输入测试 2026-10-12：原写格式串 YYYY-MM-DDTHH:mm，与 Banner 页同一类问题）
    return { ok: false, first: '生效时间没填完整：日期和时刻都要选（留空表示立即生效）' };
  return { ok: true, first: '' };
}

/**
 * ⚠️ **已删除** `MAX_RAW_RATE = 1000`（AJ-297）：它原本在前端这里与服务端
 * `domain/fx-input.ts` **各写一份字面量**，注释自称"同源"，实际上改一边忘另一边**不会红**——
 * 两份都是自己的数字，谁也不引用谁。
 *
 * 现在两端都引 `packages/shared/src/limits.ts` 的 `FX_RAW_RATE_BOUNDS`，只剩一处定义。
 * 旧注释里"管理端专属的校验上限不该进 shared（会让小程序包带上它）"这条理由，
 * 已被 `ADMIN_NOTE_MAX_LENGTH`（2026-10-02 移入 shared）的先例取代：
 * 常量几十字节，而"两端漂移"的代价是真实的（前端放行、服务端拒绝 ⇒ 用户"提交才炸"）。
 *
 * 同时把上界 1000 换成 per-quote 区间——1000 挡不住"错一位"（0.067），区间能挡。
 */

/** 折算样例用的日元金额：一个"中等订单"的量级，太大太小都看不出量级错没错。 */
const SAMPLE_JPY = 10_000;

/**
 * 保存**之前**的量级核对（全量审查 A8，2026-09-29）。
 *
 * @param {{quote?: string, rawRate?: unknown, currentRate?: number|null}} args
 *   `currentRate` 该币种**当前生效**的 rate（服务端 `fx_rates.rate`）；第一次配置时为 null。
 * @returns {{ratio: number|null, risky: boolean, sampleText: string, reason: string}}
 *
 * @why 展示汇率**直接乘进真实扣款额**（`server/src/app/pay-intent.ts` 的 `resolveCharge`：
 *      USD 分支就是 `toMinor(total_jpy, rate)`），而保存按钮此前是"一点即提交"。
 *      录成 0.00067 之后每笔美元订单少收 90%；录成 150 多收两万倍，引来拒付——
 *      两种情况**在提交时都不报任何错**。
 *
 * @why 判据是"与当前生效值的**倍数**"，不是"这个数合不合理"。
 *      ⚠️ 这里原本还有一句"绝对值没有合理范围（0.0067 和 0.049 都是对的）"——
 *      **那句论证是错的**（AJ-297 更正）：0.0067 是 USD、0.049 是 CNY，
 *      两者差 7 倍恰恰因为它们是不同币种；它把"跨币种没有一个统一区间"
 *      当成了"每个币种都没有区间"。**分币种看，两个都是有硬边界的物理量**，
 *      所以 `fxFormErrors` 现在做 per-quote 的绝对区间硬拦（错一位在输入时就报）。
 *      ⇒ 本函数的**相对**倍数核对并没有被取代，它拦的是另一类：
 *      区间之内但相对上一次跳得离谱（例如 USD 从 0.0067 改成 0.012，在区间内但翻了近一倍），
 *      以及"两个币种值串位"这类区间挡不住的错误。阈值取 ≥1.5 或 ≤0.67（约 ±50%）——
 *      日波动超过这个幅度在主要货币对上极罕见。
 *
 * @why 同时给一个**样例金额**（10,000 日元 ≈ USD 67.00）而不是只给倍数：
 *      运营核对的是"这个数看起来像不像我认识的价格"，倍数需要心算，金额一眼就能看出来。
 *
 * @limitation 一：**不做硬拦截**，只标红并要求勾选确认。
 *              @why 汇率真的会剧烈波动，硬拦会误伤真实的调价；而且"阈值多少"是一个
 *              尚未拍板的运营参数（AJ-148 登记的待办）。这里是"阈值落地前"的必要缓解。
 * @limitation 二：`currentRate` 为 null（第一次配置）时无从比较，此时**不标红**——
 *              拿不到基准却标红，等于把"首次配置"变成每次都要解释的麻烦事，
 *              于是有人会把整个确认流程删掉。首次的风险由样例金额承担。
 */
export function fxPreview(args: unknown): {
  ratio: number | null;
  risky: boolean;
  /** 没有可比对的当前生效值（首次配置 / 列表加载失败）——**不等于**"没问题"，见 `fxSaveStep`。 */
  noBaseline: boolean;
  sampleText: string;
  reason: string;
} {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const quote = typeof a['quote'] === 'string' ? a['quote'] : '';
  const raw = rawRateNumber(a['rawRate']);
  const current = a['currentRate'];

  if (!Number.isFinite(raw) || raw <= 0) {
    // 填了非法值：不在这里造文案（fxFormErrors 负责），只说"给不出预览"
    return { ratio: null, risky: false, noBaseline: false, sampleText: '', reason: '' };
  }

  // 样例金额：¥10,000 折成该币种的主单位（USD / CNY 都是 2 位小数）
  // 日元写「日元」（¥ 在本项目口径里是人民币，D-36；不写「円」见 format.ts minorMoneyText）
  const sampleText = `${SAMPLE_JPY.toLocaleString('en-US')} 日元 ≈ ${quote} ${(SAMPLE_JPY * raw).toFixed(2)}`;

  if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) {
    // ⚠️ 没有基准时**不能**当成"不可疑"（AJ-229）：上线前第一次录 USD、或列表没加载出来，
    //    恰恰是最容易"反着填 150"的时刻，而此时倍数算不出来。明说"没法比"，由 `fxSaveStep` 要求勾选。
    return {
      ratio: null,
      risky: false,
      noBaseline: true,
      sampleText,
      reason: '没有可比对的当前生效值（首次配置或列表未加载），请按样例金额人工核对',
    };
  }

  const ratio = raw / current;
  // 阈值写成 0.67 而不是 1/1.5：两个方向的判定要**互相可逆**
  // （涨到 1.5 倍标红，跌回去到 1/1.5 = 0.667 也应标红），否则会出现"改过去标红、改回来不标红"。
  const risky = ratio >= 1.5 || ratio <= 0.67;
  const pct = Math.abs(ratio - 1) * 100;
  return {
    ratio,
    risky,
    noBaseline: false,
    sampleText,
    reason: risky
      ? `与当前生效值相差约 ${pct.toFixed(0)}%（${ratio.toFixed(3)} 倍），请确认不是小数点错位`
      : '',
  };
}

/**
 * 各币种**当前生效**的原始汇率（A8 残留 / AJ-229 / ADM3-05）。
 *
 * @param list `GET /admin/fx` 的响应：**全部行**（历史 + 未来），服务端按 `quote asc, effective_from desc` 排，
 *             每行带服务端判定的 `is_current`
 * @returns 币种 → `raw_rate`；该币种没有标记为当前生效的行则不出现在结果里
 *
 * @why 面板原先逐行 `rates[q] = r`，后者覆盖前者——列表是按生效时间**倒序**的，
 *      于是留下的是每个币种**最早**的一行。首条录错、后来更正过的环境里，
 *      量级核对会反过来：录入正确值被标红，再次录错反而不标红。
 *      @measured(FxPanel.dom.unit.test.ts「基准是当前生效那一行」, 2026-09-30)：
 *        列表 = [未来 0.0071, 当前 0.0067, 最早 0.67]，修复前录 0.67 **不标可疑**（基准取成了 0.67）。
 * @why 🔴 基准**只认服务端下发的 `is_current`**，不再拿本机时钟与 `effective_from` 比（ADM3-05）：
 *      "立即生效"的时刻是服务端 `clock.now()` 打的，而管理员电脑的时钟不受我们控制——
 *      慢几分钟，刚保存的那行被判成"尚未生效"，基准回退到上一条（先录错、马上改正时，
 *      第二次核对拿的是**错误值之前**那条）；快几小时，几小时后才生效的预约行被当成当前值。
 *      "现在几点"的权威只有一个，就是服务端；前端拿着 `is_current` 不需要知道现在几点。
 * @why 取 `raw_rate` 而不是 `rate`：表单录入的就是原始汇率；拿含缓冲的 `rate` 当基准，
 *      倍数会恒偏 `1/(1+buffer)`（缓冲配大时原样重录也会被标红）。
 * @why 同币种出现多行 `is_current: true`（服务端口径异常 / 老包新包混部）时取**第一条**：
 *      列表是同币种内倒序，第一条就是最新的那行。这不该发生，但发生了也不能让基准变成
 *      "随遍历顺序而定"。
 * @limitation `is_current` **缺失不算当前**（不回退到"用时钟猜"）：
 *              那是"服务端没告诉我"，正确反应是**没有基准**——`fxSaveStep` 因此要求勾选确认
 *              （AJ-229：算不出倍数不等于安全），而不是拿一个可能错的基准算出"不可疑"。
 */
export function currentFxRawRates(list: unknown): Record<string, number> {
  const best = new Map<string, number>();
  for (const x of Array.isArray(list) ? list : []) {
    const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    const quote = typeof o['quote'] === 'string' ? o['quote'] : '';
    // form-number-normalize-ok: 值来自服务端响应（fx_rates.raw_rate），不是用户输入
    const raw = Number(o['raw_rate']);
    if (quote === '' || !Number.isFinite(raw) || raw <= 0) continue; // 脏行逐条跳过
    if (o['is_current'] !== true) continue;
    if (!best.has(quote)) best.set(quote, raw);
  }
  return Object.fromEntries(best);
}

/** 表单内容的指纹：确认与勾选都绑定在它上面，内容一变就自动作废（@see `fxSaveStep`）。 */
export function fxFormKey(form: unknown): string {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return `${s(f['quote'])}|${s(f['rawRate'])}|${s(f['effectiveFrom'])}`;
}

/**
 * 点"保存"之后该做什么。
 *
 * @why `save` 分支也带 `requireAck`（ADM3-03）：面板曾用 `step.kind === 'confirm' && step.requireAck`
 *      决定要不要渲染"我已核对"复选框，而勾选之后 `kind` 就变成了 `save`——复选框当场被卸载。
 *      运营想撤回勾选再核对一遍时，页面上连那个框都没有了，只能"取消"重来，
 *      事后也看不出这一步做过没有。"要不要勾"是**这一笔值**的性质，不该随"勾没勾"变化。
 */
export type FxSaveStep =
  | { kind: 'invalid'; message: string }
  | { kind: 'confirm'; requireAck: boolean }
  | { kind: 'save'; requireAck: boolean };

/**
 * 汇率保存的闸门（A8 残留 / AJ-229）：形状校验 → 一律二次确认 → 可疑或无基准时再要勾选。
 *
 * @param a.form 当前表单
 * @param a.currentRate 该币种当前生效的原始汇率；取不到为 null
 * @param a.confirmKey 已经点过"保存"进入确认态的那份表单的指纹（没有为 null）
 * @param a.ackKey 已经勾过"我已核对"的那份表单的指纹（没有为 null）
 *
 * @why **一律两步**（不只在可疑时）：汇率直接乘进美元实扣额，录错在提交时不报任何错；
 *      0.67–1.5 倍之间的改动（比如涨 45%）同样值得看一眼样例金额再确认。
 * @why 确认与勾选**绑定表单指纹**而不是两个布尔：原来是"进入确认态 → 勾选 → 保存"三个独立状态，
 *      确认态下改值或换币种都不复位，勾完再改成另一个量级可以直接提交。
 *      绑定指纹后，内容一变，旧的确认与勾选自然对不上——没有"忘了复位"这种写法。
 * @why 无基准（`currentRate === null`）按"要勾选"处理：算不出倍数不等于安全。
 * @limitation 只是**前端**的闸：服务端 `POST /admin/fx` 仍只查形状与上下界，
 *              拿着管理员 token 直接调接口可以绕过。服务端按倍数拦截要改契约（加确认标志），
 *              登记为待办，未在本单元做。
 */
export function fxSaveStep(a: {
  form: unknown;
  currentRate: number | null;
  confirmKey: string | null;
  ackKey: string | null;
}): FxSaveStep {
  const check = fxFormErrors(a.form);
  if (!check.ok) return { kind: 'invalid', message: check.first };
  const f = (typeof a.form === 'object' && a.form !== null ? a.form : {}) as Record<
    string,
    unknown
  >;
  const preview = fxPreview({
    quote: f['quote'],
    rawRate: f['rawRate'],
    currentRate: a.currentRate,
  });
  const requireAck = preview.risky || preview.noBaseline;
  const key = fxFormKey(a.form);
  if (a.confirmKey !== key) return { kind: 'confirm', requireAck };
  if (requireAck && a.ackKey !== key) return { kind: 'confirm', requireAck };
  return { kind: 'save', requireAck };
}

/** 保存成功后的提示：填了生效时间就不是"立即生效"（原文案恒说立即）。 */
export function fxSavedText(form: unknown): string {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const from = typeof f['effectiveFrom'] === 'string' ? f['effectiveFrom'].trim() : '';
  return from === ''
    ? '已保存（新的展示价立即按新汇率计算）'
    : '已保存（到所填的生效时间后，展示价才按新汇率计算）';
}

/**
 * 表单 → 契约 `POST /admin/fx` 请求体。
 * @why `effective_from` 空则**不带**（契约可选项）：传空串会被当成非法 date-time，
 *      而"不传"的语义是"立即生效"，正是运营点保存时的意图。
 */
export function toFxBody(form: unknown): Record<string, unknown> {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  // 与 fxFormErrors / fxPreview 同一个解析入口：全角按半角认，提交出去的是半角数字
  const raw = rawRateNumber(f['rawRate']);
  const from = typeof f['effectiveFrom'] === 'string' ? f['effectiveFrom'].trim() : '';
  return {
    quote: typeof f['quote'] === 'string' ? f['quote'] : '',
    raw_rate: raw,
    ...(from === '' ? {} : { effective_from: toIsoJst(from) }),
  };
}

/** 运费分档行（展示用，按上限升序）。 */
export interface RateViewRow {
  carrier: string;
  maxWeightText: string;
  priceText: string;
  active: boolean;
  /** 同一上限出现多次（DB 有 UNIQUE(carrier, max_weight_g)，重复会整表替换失败）。 */
  duplicate: boolean;
}

/**
 * 表单里哪些行是"档位重复"——**按表单行的原顺序**返回（AJ-232）。
 *
 * @param rows 编辑中的表单行（`carrier` 与 `maxWeightG` 文本）
 * @returns 与入参**等长、同序**的布尔数组
 *
 * @why 面板原先用 `rateRows(...)[i].duplicate` 标记第 i 行，而 `rateRows` 会按重量**排序**：
 *      表格没按重量排时，排序后的第 i 项不是表格的第 i 行，"档位重复"会标到别的行上。
 *      运营照着标记去改，改的是没问题的那一行。
 * @why 重量按**数值**比（`'500'` 与 `'0500'`、`' 500 '` 是同一档）：DB 的唯一约束比的是整数。
 *      认不出数值的行（空 / 非数字）不参与判重——它们由 `rateErrors` 另行报"必填 / 非法"。
 */
export function rateDuplicates(rows: unknown): boolean[] {
  if (!Array.isArray(rows)) return [];
  const keyOf = (x: unknown): string | null => {
    const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    const w = typeof o['maxWeightG'] === 'string' ? o['maxWeightG'].trim() : '';
    if (!/^\d+$/.test(w)) return null;
    const carrier = typeof o['carrier'] === 'string' ? o['carrier'].trim() : '';
    return `${carrier}|${Number(w)}`;
  };
  const keys = rows.map(keyOf);
  const count = new Map<string, number>();
  for (const k of keys) if (k !== null) count.set(k, (count.get(k) ?? 0) + 1);
  return keys.map((k) => k !== null && (count.get(k) ?? 0) > 1);
}

/**
 * `ShippingRate[]` → 展示行（**按 max_weight_g 升序**）。
 * @why 排序放在这里：分档表的语义就是"从轻到重"，乱序展示时运营很难看出
 *      "这一档的上限比上一档还小"——而那正是取档会静默错的原因。
 */
export function rateRows(items: unknown): RateViewRow[] {
  if (!Array.isArray(items)) return [];
  const rows = items
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      carrier: typeof x['carrier'] === 'string' ? x['carrier'] : '',
      // form-number-normalize-ok: 值来自服务端响应（shipping_rates 行），不是用户输入
      maxWeightG: Number(x['max_weight_g']),
      priceJpy: Number(x['price_jpy']),
      active: x['active'] !== false,
    }))
    .sort((a, b) => a.maxWeightG - b.maxWeightG);
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.carrier}|${r.maxWeightG}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return rows.map((r) => ({
    carrier: r.carrier,
    maxWeightText: Number.isInteger(r.maxWeightG) ? `${r.maxWeightG} g` : '—',
    priceText: moneyText(Number.isInteger(r.priceJpy) ? r.priceJpy : null),
    active: r.active,
    duplicate: (seen.get(`${r.carrier}|${r.maxWeightG}`) ?? 0) > 1,
  }));
}

/**
 * 表单里的数值字段 → 整数；**空串与非法都返回 null**（全量审查 A7，2026-09-29）。
 *
 * @why 原来的写法是 `Number(v)`，而 `Number('')` 等于 **0**：
 *      "≥0 的整数"这道校验会**放行空值**，提交时又把空值转成 `price_jpy: 0`。
 *      服务端把 0 円视为合法的"手动包邮"，于是运营"新增一档"只填了重量上限、
 *      没填运费（或清空后忘了重填），确认之后**这个重量段的所有订单运费都是 0**，
 *      不报任何错——正是文件头引用的 D-46 那类"每单少收钱且静默"。
 *      重量上限因为要求 ≥1，空值会被拦下；**运费没有同等拦截**，不对称正是漏洞所在。
 *
 * @why 用 `/^\d+$/` 而不是 `Number()` / `parseInt()`：后两者会接受
 *      `'1e3'`（`Number` → 1000）、`'0x10'`（`Number` → 16）、`'12abc'`（`parseInt` → 12）。
 *      这些都能"看着通过了校验"，实际写进库的是运营没打算写的数。
 *
 * @limitation 只认**十进制非负整数字符串**与已经是整数的 number；
 *              负数、小数、科学计数法、十六进制一律 null（由调用方转成各自的报错文案）。
 */
function parseCount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  // 全角数字按半角认（三天提交复查 2026-10-12：2593097 修了排序 / 库存，运费表漏了）
  const t = halfWidth(v);
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/**
 * 整表校验（@see @limitation 一）。
 * @returns 全部问题（不是第一条）：整表替换一次提交，逐条报要提交很多次。
 */
export function rateErrors(rows: unknown): {
  ok: boolean;
  errors: string[];
  first: string;
  /** 出错的格子 `行下标:字段`（carrier / maxWeightG / priceJpy），供表格标红（全入口点击测试 2026-10-12）。 */
  cells: string[];
} {
  const list = Array.isArray(rows) ? rows : [];
  const errors: string[] = [];
  const cells: string[] = [];
  if (list.length === 0) errors.push('至少保留一档运费（空表会让所有订单无法报价）');

  // ⚠️ 判重**复用** `rateDuplicates`，不在这里自己拼 key（ADM3-06）。
  //    @why 这里曾经用 `${carrier}|${String(max)}`，而 `max` 为 null（重量没填）时
  //    `String(null)` 是 `'null'`：连续点两次"新增一档"、重量都留空，
  //    底部错误区就会出现"与前面某一档的承运商 + 上限重复（DB 唯一约束会拒）"——
  //    而行上的"档位重复"标记（它读的是 `rateDuplicates`）**不亮**，两处说法互相矛盾，
  //    运营会去找一个根本不存在的重复。判重的口径只能有一个来源。
  const dupFlags = rateDuplicates(list);
  list.forEach((raw, i) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const carrier = typeof r['carrier'] === 'string' ? r['carrier'].trim() : '';
    const maxRaw = r['maxWeightG'] ?? r['max_weight_g'];
    const priceRaw = r['priceJpy'] ?? r['price_jpy'];
    const max = parseCount(maxRaw);
    const price = parseCount(priceRaw);
    const at = `第 ${i + 1} 档`;
    if (carrier === '') {
      errors.push(`${at}：承运商必填`);
      cells.push(`${String(i)}:carrier`);
    } else if (carrier.length > SHIPPING_RATE_BOUNDS.carrierChars) {
      // 与服务端 carrier_invalid 同一上限（两端输入测试 2026-10-12：原先前端放行、服务端回泛化 40001）
      errors.push(`${at}：承运商名最多 ${String(SHIPPING_RATE_BOUNDS.carrierChars)} 个字`);
      cells.push(`${String(i)}:carrier`);
    }
    // ⚠️ "没填"与"填错了"要分开报：合并成一句的话，运营看到"必须是 ≥0 的整数"
    //    会以为自己填了非法值，而实际是**根本没填**——后者才是真正的静默事故。
    if (max === null || max < 1 || max > SHIPPING_RATE_BOUNDS.maxWeightG)
      cells.push(`${String(i)}:maxWeightG`);
    if (max === null) {
      errors.push(
        typeof maxRaw === 'string' && maxRaw.trim() === ''
          ? `${at}：重量上限必填`
          : `${at}：重量上限必须是 ≥1 的整数（克）`,
      );
    } else if (max < 1) {
      errors.push(`${at}：重量上限必须是 ≥1 的整数（克）`);
    } else if (max > SHIPPING_RATE_BOUNDS.maxWeightG) {
      // 与服务端 `max_weight_g_out_of_range` 同源（shared 常量）：不补的话服务端只回泛化的 40001
      errors.push(
        `${at}：重量上限不能超过 ${SHIPPING_RATE_BOUNDS.maxWeightG} 克（承运商单件上限 30kg；请检查是否多打了 0）`,
      );
    }
    if (price === null || price > SHIPPING_RATE_BOUNDS.priceJpy)
      cells.push(`${String(i)}:priceJpy`);
    if (price === null) {
      errors.push(
        typeof priceRaw === 'string' && priceRaw.trim() === ''
          ? `${at}：运费必填（包邮请显式填 0，不要留空）`
          : `${at}：运费必须是 ≥0 的整数（日元）`,
      );
    } else if (price > SHIPPING_RATE_BOUNDS.priceJpy) {
      errors.push(
        `${at}：运费不能超过 ${SHIPPING_RATE_BOUNDS.priceJpy} 日元（请检查是否多打了 0）`,
      );
    }
    if (dupFlags[i] === true)
      errors.push(`${at}：与前面某一档的承运商 + 上限重复（DB 唯一约束会拒）`);
  });

  if (!list.some((r) => (r as { active?: unknown } | null)?.active !== false))
    errors.push('至少要有一档是启用状态（全停用 = 没有运费可算）');

  // 🔴 启用档位必须**恰好一家**承运商（服务端 `carrier_not_single`，D-46 同源守卫）。
  //    @why 服务端拒绝时回的是泛化的 40001「参数缺失或格式错误」，运营看不出是哪里错；
  //    前端在这里把原因说清楚。两家以上同时启用 = 取档不知道该用哪家的表 ⇒ 全站报价 50004。
  //    @limitation 承运商名按 trim 后**原样**比较（大小写不同算两家），与服务端口径一致。
  const activeCarriers = new Set<string>();
  for (const raw of list) {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const c = typeof r['carrier'] === 'string' ? r['carrier'].trim() : '';
    if (r['active'] !== false && c !== '') activeCarriers.add(c);
  }
  if (activeCarriers.size > 1)
    errors.push(
      `启用中的档位只能属于同一家承运商（现在有 ${[...activeCarriers].join('、')}）：请停用其他承运商的档位，或改成同一个承运商名`,
    );

  return { ok: errors.length === 0, errors, first: errors[0] ?? '', cells };
}

/** 表单行 → 契约 `ShippingRate`（键名换成服务端 snake_case）。 */
export function toRateBody(rows: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((raw) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    // ⚠️ 与 `rateErrors` 用**同一个** `parseCount`，且解析不出时**抛错而不是回落 0**。
    //    @why 本函数只在 `rateErrors().ok` 之后被调用（RatesPanel.save 先校验），
    //    所以走到这里还解析不出 = 校验与组装两边口径已经漂移，那是一个**必须响亮失败**
    //    的内部不一致；回落成 0 就又回到"静默按 0 円运费提交"（A7 的原病）。
    const max = parseCount(r['maxWeightG'] ?? r['max_weight_g']);
    const price = parseCount(r['priceJpy'] ?? r['price_jpy']);
    if (max === null || price === null) {
      throw new Error(
        `运费行无法解析为整数（maxWeightG=${String(r['maxWeightG'])}，priceJpy=${String(
          r['priceJpy'],
        )}）：整表替换已中止，未提交任何改动`,
      );
    }
    return {
      carrier: typeof r['carrier'] === 'string' ? r['carrier'].trim() : '',
      max_weight_g: max,
      price_jpy: price,
      active: r['active'] !== false,
    };
  });
}

/** 新增一档时的默认值（上限留空，逼运营填而不是继承上一档）。 */
export function emptyRateRow(carrier = ''): RateRow {
  return { carrier, maxWeightG: '', priceJpy: '', active: true };
}
