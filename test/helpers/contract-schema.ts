/**
 * 职责：用契约（contracts/api-contract.yaml）里的 schema 校验**响应**形状（E-8，工程缺口 2026-10-08）。
 *
 * @why 已有的契约检查只管请求侧（错误码 / 枚举双向比对、请求字段上限），响应字段改名 / 删字段没有机械检查——
 *      当天就踩过一次：同类推荐按详情的 `images[]` 读列表的 `image`，测试数据也按错的形状写，模拟器里才发现。
 * @why 自己写一个**子集**校验器而不引 ajv：只支持契约实际用到的关键字（type / required / properties / items /
 *      $ref / allOf / enum / nullable / minimum / maximum），约 60 行；多一个依赖换不来什么（项目约定少引依赖）。
 * @why **契约里没有的键也报**（对象声明了 properties 时）：改名在服务端表现为"多出一个新键"，
 *      只查必填抓不到（契约里大多数字段不是 required）。
 * @limitation 一：不认的关键字（format / description / oneOf …）一律忽略，不报错也不校验——
 *              契约将来用上 oneOf 时这里要补，否则那一段等于没验（单测"四个关键 schema 都在"只保证能加载）。
 * @limitation 二：只验"有的键形状对不对、有没有多出来的键"，验不了"不该省略的键被省略了"（除非契约标了 required）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Schema = Record<string, unknown>;
type Schemas = Record<string, Schema>;

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (s: string) => unknown };
const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), '../../contracts/api-contract.yaml');

let cache: Schemas | undefined;
/** 契约 `components.schemas` 全表（读一次缓存）。 */
export function contractSchema(): Schemas {
  cache ??= (load(readFileSync(CONTRACT, 'utf8')) as { components: { schemas: Schemas } })
    .components.schemas;
  return cache;
}

const REF = '#/components/schemas/';
const deref = (all: Schemas, s: Schema): Schema =>
  typeof s['$ref'] === 'string' ? (all[(s['$ref'] as string).slice(REF.length)] ?? {}) : s;

/** allOf 展开后的 properties 并集（判"契约里没有的键"用）。 */
function allProps(all: Schemas, s0: Schema): Record<string, Schema> | undefined {
  const s = deref(all, s0);
  let props: Record<string, Schema> | undefined =
    s['properties'] !== undefined ? { ...(s['properties'] as Record<string, Schema>) } : undefined;
  for (const part of (s['allOf'] as Schema[] | undefined) ?? []) {
    const p = allProps(all, part);
    if (p !== undefined) props = { ...(props ?? {}), ...p };
  }
  return props;
}

function typeOk(t: unknown, v: unknown): boolean {
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return typeof v === 'object' && v !== null && !Array.isArray(v);
  return typeof v === t;
}

function walk(
  all: Schemas,
  s0: Schema,
  v: unknown,
  path: string,
  out: string[],
  top: boolean,
): void {
  const s = deref(all, s0);
  if (v === null) {
    if (s['nullable'] !== true) out.push(`${path} 不可为 null`);
    return;
  }
  for (const part of (s['allOf'] as Schema[] | undefined) ?? [])
    walk(all, part, v, path, out, false);
  if (s['type'] !== undefined && !typeOk(s['type'], v)) {
    out.push(
      `${path} 应为 ${String(s['type'])}，实际 ${JSON.stringify(v)?.slice(0, 40) ?? 'undefined'}`,
    );
    return;
  }
  if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).includes(v))
    out.push(`${path} 不在枚举`);
  if (typeof v === 'number' && typeof s['minimum'] === 'number' && v < s['minimum'])
    out.push(`${path} 小于 ${String(s['minimum'])}`);
  if (typeof v === 'number' && typeof s['maximum'] === 'number' && v > s['maximum'])
    out.push(`${path} 大于 ${String(s['maximum'])}`);
  if (Array.isArray(v) && s['items'] !== undefined)
    v.forEach((x, i) => walk(all, s['items'] as Schema, x, `${path}[${String(i)}]`, out, true));
  if (typeof v !== 'object' || Array.isArray(v)) return;
  const o = v as Record<string, unknown>;
  for (const k of (s['required'] as string[] | undefined) ?? [])
    if (!(k in o)) out.push(`${path}.${k} 缺失`);
  const own = s['properties'] as Record<string, Schema> | undefined;
  for (const [k, ps] of Object.entries(own ?? {}))
    if (k in o) walk(all, ps, o[k], `${path}.${k}`, out, true);
  // 多余键只在"这一层的完整视图"上判一次（allOf 的分支各自只看到一半属性，在那里判会误报）
  const props = top ? allProps(all, s0) : undefined;
  if (props !== undefined)
    for (const k of Object.keys(o)) if (!(k in props)) out.push(`${path}.${k} 契约里没有`);
}

/**
 * 按契约 schema 校验一个值。
 * @param all schema 表（通常是 `contractSchema()`；单测传内联小表）
 * @param name schema 名（如 `Product`）
 * @returns 问题清单（空 = 合法），每条带 JSON 路径，如 `$.items[0].image 契约里没有`
 */
export function checkShape(all: Schemas, name: string, value: unknown): string[] {
  const out: string[] = [];
  walk(all, { $ref: `${REF}${name}` }, value, '$', out, true);
  return out;
}
