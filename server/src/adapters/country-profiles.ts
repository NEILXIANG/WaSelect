/**
 * 职责：目的国档案仓储（F11 单元④）——把"某个目的国怎么校验地址、展示什么币、走哪些承运商"
 *      从硬编码搬进 `country_profiles` 表，并提供**唯一**的读取口。
 *
 * 边界：只做「读 + 解析 + 校验」。不做地址校验本身、不做关税计算、不做承运商选择——
 *      那三件事是业务（ADR-28 分别列 P1/P2），它们将来**注入本仓库**而不是反过来。
 *
 * @why 解析必须带**结构校验**而不是直接 `as CountryProfile` 强转：国家档案是运营手工维护的 JSONB，
 *      一次手滑（字段名拼错、pattern 多打一个反斜杠）在强转下会变成"运行时 undefined"，
 *      表现为表单渲染少一个输入框、或者地址校验突然全过/全不过，且日志里什么都没有。
 *      校验在这里响亮失败，坏数据就在"它被读到的那一刻"暴露，而不是在用户下单时才炸。
 *
 * @why 正则要**试编译**（compilePattern）：PG 没有"这串字符是不是合法正则"的约束，
 *      非法正则只在真去匹配时才抛 `SyntaxError`——那已经在一个用户请求里了，
 *      而且抛的是"正则坏了"，不是"哪个国家的哪个字段坏了"，排查要翻库。
 *      在读取时试编译，错误里能带上 `code` 与字段名。
 *
 * @tradeoff 坏数据**抛错**而不是跳过：跳过一条坏数据的代价是"下单页少一个国家且没人知道"，
 *          抛错的代价是"一个国家配坏了，相关请求全 500"。国家档案是运营配置、量极小、
 *          写错必须有人来修，所以选"响亮失败"——静默降级在配置类数据上永远是错的。
 *
 * @limitation 一：**不做缓存**（与 identity.ts 的 60s 缓存刻意不同）。国家档案当前没有消费方，
 *              现在加缓存等于为一条没人走的路径设计过期策略；等第一个真实调用方落地时，
 *              按它的调用频率决定 TTL（参照 identity.ts 的取舍链）。
 * @limitation 二：错误信息里带 `code` 与字段路径，但**不记日志**——本文件没有 logger，
 *              刻意不为了"记一行"而引入一条 adapters → logger 的依赖。
 *              第一个真实调用方（路由层，自带 logger）必须 catch 并记 error：
 *              配置损坏是运营事故级，只有调用方日志能回答"什么时候开始坏的"。
 * @limitation 三：`code` 用 `string`（只校验 `^[A-Z]{2}$`）而**不绑** shared 的 `Country` 枚举。
 *              绑枚举会让"加一个国家"变成改代码 + 发版，正是 ADR-28 要消灭的事。
 *              反例是 `displayCurrencies` 绑了 `Currency` 枚举——币种是有穷集合且影响金额显示，
 *              写错会静默显示错误符号，那里的"可扩展性"不值得用正确性换。
 * @limitation 四：类型定义暂留在 adapters 层而**不进 shared**。它现在没有跨端消费者
 *              （没有 `/countries` 端点、前端没有按 schema 渲染表单），提前搬进 shared
 *              等于把"前端到底需要哪些字段"这个问题推迟到被迫用时。
 *              触发条件：`GET /countries`（或等价端点）落地时连同契约一起搬。
 *
 * @see migrations/007_country_profiles.sql（表与 US 种子，seed 值逐字等于 addresses 的现行约束）；
 *      docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md §3.2（ADR-28，字段定义来源）；
 *      server/src/adapters/identity.ts（同形态的"端口 + PG 实现 + 可选缓存"写法）
 */
import { z } from 'zod';
import { CURRENCY, type Currency } from '@waselect/shared';
import type { Db } from './db.js';

/** 地址表单的一个字段；同时驱动后端校验与前端渲染。 */
export interface AddressFieldSpec {
  /** 字段键。**约定等于 `addresses` 表的列名**，否则"模板 → 落库"要写一张映射表（见 @limitation 五）。 */
  key: string;
  /** 前端展示名。 */
  label: string;
  required: boolean;
  /** 校验正则（字符串形态，前端与后端共用）。undefined = 该字段只校验长度与必填。 */
  pattern?: string | undefined;
  /** 最大长度；**必须 ≤ 对应列宽**，否则前端让填、后端落库时被 PG 拒（见同源比对测试）。 */
  maxLength?: number | undefined;
  /** 枚举选项（如将来的州列表）。undefined = 自由输入。 */
  options?: string[] | undefined;
}

/** 地址表单模板。 */
export interface AddressTemplate {
  fields: AddressFieldSpec[];
}

/** 一个目的国的完整档案。 */
export interface CountryProfile {
  code: string;
  /** 是否可下单。false 时仍可被 `get()` 读到（见 CountryProfileRepo.get）。 */
  active: boolean;
  /** JPY 是定价锚、恒显示；这里是锚之外要并列的展示币。 */
  displayCurrencies: Currency[];
  addressTemplate: AddressTemplate;
  phonePattern: string;
  postalPattern: string;
  /** 允许的承运商；MVP 为空数组（尚无真实承运商数据，见迁移 @limitation 二）。 */
  allowedCarriers: string[];
  /** 该国不可售的合规标签；MVP 为空数组（合规标签尚无枚举口径）。 */
  blockedTags: string[];
  /** 前端展示的关税口径文案（MVP 为 DDP）。 */
  dutyNote: string;
}

/**
 * 目的国档案读取口。**两个方法语义不同，别混用**：
 * - `get(code)`：**不管 active**。null 只表示"表里没有这个国家"。
 *   @why 后台编辑、以及"解释为什么这个国家不能下单"都要能读到已下线的条目。
 *        若 get 只返回 active 的，"国家被下线"与"国家不存在"在调用方眼里都是 null，
 *        日志里只剩一个 null，两类成因无法区分——与支付注册表
 *        get / getForRefund / getForCallback 拆三个方法是同一个教训（AJ-52）。
 * - `listActive()`：只给"下单可选目的国"这类场景用。
 */
export interface CountryProfileRepo {
  get(code: string): Promise<CountryProfile | null>;
  listActive(): Promise<CountryProfile[]>;
}

/**
 * 试编译一个正则字符串。
 * @returns 原样返回入参（便于链式使用）。
 * @throws 不可编译、或**空字符串**时抛错。
 * @why 空 pattern 是合法正则，但它匹配一切——对校验字段来说那等于"校验形同虚设"，
 *      而它长得跟"这个字段不用校验"一模一样。所以空串按坏数据处理。
 */
export function compilePattern(pattern: string, field: string, code: string): string {
  if (pattern.trim() === '') {
    throw new Error(`country_profiles[${code}].${field}：pattern 为空（会匹配一切，等于不校验）`);
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new Error(`country_profiles[${code}].${field}：pattern 不是合法正则 —— ${String(err)}`);
  }
  return pattern;
}

const addressFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean(),
  pattern: z.string().optional(),
  maxLength: z.number().int().positive().optional(),
  options: z.array(z.string()).optional(),
});

/** 库行形态（snake_case）的 schema。字段与 migrations/007 的列逐项对应。 */
const rowSchema = z.object({
  code: z.string().regex(/^[A-Z]{2}$/, 'code 必须是两位大写字母'),
  active: z.boolean(),
  display_currencies: z.array(z.enum(CURRENCY)),
  address_template: z.object({
    fields: z.array(addressFieldSchema).min(1, '地址模板至少一个字段'),
  }),
  phone_pattern: z.string(),
  postal_pattern: z.string(),
  allowed_carriers: z.array(z.string()),
  blocked_tags: z.array(z.string()),
  duty_note: z.string(),
});

/** 把 zod 的 issue 列表压成一行（错误信息要能进日志与终端，不能带换行）。 */
function issuesText(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
    .join('; ')
    .slice(0, 300);
}

/**
 * 库行 → 领域对象（snake_case → camelCase + 结构校验 + 正则试编译）。
 * @throws 结构非法、正则不可编译、或字段 key 重复时抛错，错误里带 `code`。
 * @why key 重复要单独查：两个同名 key 会让前端渲染出两个同名输入框（值互相覆盖，
 *      表现为"填了州，州莫名变回上一个值"），而 JSON 本身完全合法、schema 也过得去。
 */
export function parseCountryProfileRow(raw: unknown): CountryProfile {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) {
    const code = (raw as { code?: unknown } | null)?.code;
    throw new Error(`country_profiles 行非法（code=${String(code)}）：${issuesText(parsed.error)}`);
  }
  const r = parsed.data;
  const keys = r.address_template.fields.map((f) => f.key);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup !== undefined) {
    throw new Error(`country_profiles[${r.code}]：地址字段 key 重复 —— "${dup}"`);
  }
  for (const f of r.address_template.fields) {
    if (f.pattern !== undefined) compilePattern(f.pattern, `address_template.${f.key}`, r.code);
  }
  return {
    code: r.code,
    active: r.active,
    displayCurrencies: r.display_currencies,
    addressTemplate: { fields: r.address_template.fields },
    phonePattern: compilePattern(r.phone_pattern, 'phone_pattern', r.code),
    postalPattern: compilePattern(r.postal_pattern, 'postal_pattern', r.code),
    allowedCarriers: r.allowed_carriers,
    blockedTags: r.blocked_tags,
    dutyNote: r.duty_note,
  };
}

/**
 * Postgres 实现。
 * @why 两次查询都只取需要的列、都不联表：国家档案会被"报价/建单/下单页"反复读，
 *      任何多余列都会在最热的路径上累加。
 * @why 列清单在两处**各手写一遍**而不是抽成一个拼接常量——抽常量就得用 `db.unsafe()`，
 *      那是本仓库里只有建库脚本才用的口子。手写的漂移风险由 `rowSchema` 兜住：
 *      SELECT 少一列 → 解析时该字段缺失 → zod 报 required → 真库用例**当场变红**。
 *      也就是说"漏列"不可能是静默的，这个兜底比一个拼接常量更硬。
 * @limitation `listActive()` 用 `order by code` 而不是按运营配置的顺序：
 *              当前没有"展示顺序"这个字段。将来若后台要能调顺序，加 `sort INT` 列并改这一行——
 *              不要靠"插入顺序"，行在表里的物理顺序会被 UPDATE 改变（PG 的 HOT update）。
 */
export function createCountryProfileRepo(db: Db): CountryProfileRepo {
  return {
    async get(code: string): Promise<CountryProfile | null> {
      const rows = await db`
        select code, active, display_currencies, address_template, phone_pattern,
               postal_pattern, allowed_carriers, blocked_tags, duty_note
        from country_profiles where code = ${code}
      `;
      const row: unknown = rows[0];
      if (row === undefined) return null;
      return parseCountryProfileRow(row);
    },
    async listActive(): Promise<CountryProfile[]> {
      const rows = await db`
        select code, active, display_currencies, address_template, phone_pattern,
               postal_pattern, allowed_carriers, blocked_tags, duty_note
        from country_profiles where active = true order by code
      `;
      return (rows as unknown[]).map(parseCountryProfileRow);
    },
  };
}
