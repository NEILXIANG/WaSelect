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
import { formatJst, moneyText, toIsoJst } from '../format.js';

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
  quote: string;
  rateText: string;
  rawRateText: string;
  bufferText: string;
  effectiveText: string;
}

/** `FxRate[]` → 列表行（未知 quote 原样显示，不猜）。 */
export function fxRows(items: unknown): FxRow[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      quote: typeof x['quote'] === 'string' ? x['quote'] : '—',
      rateText: num(x['rate']),
      rawRateText: num(x['raw_rate']),
      bufferText: num(x['buffer']),
      effectiveText: formatJst(x['effective_from']),
    }));
}

function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
}

/**
 * 汇率表单校验。
 * @why raw_rate 要求 **> 0 的有限数**：0 或负数会让展示价变成 0 或负数，
 *      而契约只说 `type: number`——服务端不会替我们挡住 0。
 */
export function fxFormErrors(form: unknown): { ok: boolean; first: string } {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const quote = typeof f['quote'] === 'string' ? f['quote'] : '';
  const raw = Number(f['rawRate']);
  const from = typeof f['effectiveFrom'] === 'string' ? f['effectiveFrom'] : '';
  if (!(FX_QUOTES as readonly string[]).includes(quote))
    return { ok: false, first: '币种必须是 CNY 或 USD' };
  if (!Number.isFinite(raw) || raw <= 0) return { ok: false, first: '原始汇率必须是大于 0 的数字' };
  if (from !== '' && toIsoJst(from) === '')
    return { ok: false, first: '生效时间格式为 YYYY-MM-DDTHH:mm（留空表示立即生效）' };
  return { ok: true, first: '' };
}

/**
 * 表单 → 契约 `POST /admin/fx` 请求体。
 * @why `effective_from` 空则**不带**（契约可选项）：传空串会被当成非法 date-time，
 *      而"不传"的语义是"立即生效"，正是运营点保存时的意图。
 */
export function toFxBody(form: unknown): Record<string, unknown> {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const raw = typeof f['rawRate'] === 'string' ? f['rawRate'].trim() : '';
  const from = typeof f['effectiveFrom'] === 'string' ? f['effectiveFrom'].trim() : '';
  return {
    quote: typeof f['quote'] === 'string' ? f['quote'] : '',
    raw_rate: Number(raw),
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
  const t = v.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/**
 * 整表校验（@see @limitation 一）。
 * @returns 全部问题（不是第一条）：整表替换一次提交，逐条报要提交很多次。
 */
export function rateErrors(rows: unknown): { ok: boolean; errors: string[]; first: string } {
  const list = Array.isArray(rows) ? rows : [];
  const errors: string[] = [];
  if (list.length === 0) errors.push('至少保留一档运费（空表会让所有订单无法报价）');

  const seen = new Set<string>();
  list.forEach((raw, i) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const carrier = typeof r['carrier'] === 'string' ? r['carrier'].trim() : '';
    const maxRaw = r['maxWeightG'] ?? r['max_weight_g'];
    const priceRaw = r['priceJpy'] ?? r['price_jpy'];
    const max = parseCount(maxRaw);
    const price = parseCount(priceRaw);
    const at = `第 ${i + 1} 档`;
    if (carrier === '') errors.push(`${at}：承运商必填`);
    // ⚠️ "没填"与"填错了"要分开报：合并成一句的话，运营看到"必须是 ≥0 的整数"
    //    会以为自己填了非法值，而实际是**根本没填**——后者才是真正的静默事故。
    if (max === null) {
      errors.push(
        typeof maxRaw === 'string' && maxRaw.trim() === ''
          ? `${at}：重量上限必填`
          : `${at}：重量上限必须是 ≥1 的整数（克）`,
      );
    } else if (max < 1) {
      errors.push(`${at}：重量上限必须是 ≥1 的整数（克）`);
    }
    if (price === null) {
      errors.push(
        typeof priceRaw === 'string' && priceRaw.trim() === ''
          ? `${at}：运费必填（包邮请显式填 0，不要留空）`
          : `${at}：运费必须是 ≥0 的整数（円）`,
      );
    }
    const key = `${carrier}|${String(max)}`;
    if (seen.has(key)) errors.push(`${at}：与前面某一档的承运商 + 上限重复（DB 唯一约束会拒）`);
    seen.add(key);
  });

  if (!list.some((r) => (r as { active?: unknown } | null)?.active !== false))
    errors.push('至少要有一档是启用状态（全停用 = 没有运费可算）');

  return { ok: errors.length === 0, errors, first: errors[0] ?? '' };
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
