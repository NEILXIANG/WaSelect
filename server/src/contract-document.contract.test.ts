/**
 * 职责：**契约文件本身是一份合法、自洽的 OpenAPI 文档**（测试审查 U-J12）。
 *
 * @why 测试审查实测：`contracts/api-contract.yaml` 在 0.6.1～0.6.8 的变更记录被追加到了
 *      `components.schemas` **中间**（而不是 `info.description`），整个文件**不再是合法 YAML**——
 *      js-yaml：`can not read a block mapping entry; a multiline key may not be an implicit key (366:53)`。
 *      任何按 OpenAPI 读它的工具（文档站、代码生成、前端类型、第三方联调）都会直接报错。
 *      而全仓的契约检查**没有一处真正解析 YAML**：`scripts/check-contract.mjs` 按文本匹配、
 *      `routes.contract.test.ts` 按行正则抽 paths——两者都在一份坏文件上照样绿了 8 个版本。
 *      本文件用真解析器把"它是一份能被读懂的契约"变成门禁。
 * @why 同时核对行正则解析器与真解析器抽出的路由集合相等：`routes.contract.test.ts` 的比对
 *      建立在行正则之上，若两者分歧（缩进/写法变化），那条比对就在比一个错误的集合。
 *
 * @limitation 只做结构层校验（可解析、引用可解、形状对），不做 OpenAPI 规范的全量语义校验
 *              （那需要引入专门的校验器依赖，收益不抵成本；形状层已能抓住本次这类事故）。
 *
 * @see contracts/api-contract.yaml；app/route-snapshot.ts parseContractRoutes；
 *      docs/自主决策记录.md AJ-174
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import { MAX_CLIENT_KEY_LENGTH } from './ports/idempotency.js';
import { normalizeRoutePath, parseContractRoutes } from './app/route-snapshot.js';

const { load: loadYaml } = createRequire(import.meta.url)('js-yaml') as {
  load: (s: string) => unknown;
};

const TEXT = readFileSync(new URL('../../contracts/api-contract.yaml', import.meta.url), 'utf8');

interface Doc {
  openapi: string;
  info: { version: string; description: string };
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, Record<string, unknown>>;
}

function collectRefs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectRefs(n, out);
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
}

describe('契约文件是合法、自洽的 OpenAPI 文档', () => {
  it('能被真 YAML 解析器读取（不是只靠文本匹配"看起来像"）', () => {
    expect(() => loadYaml(TEXT)).not.toThrow();
  });

  it('顶层形状：openapi 3.x / info / paths / components.schemas；每个 schema 都是对象', () => {
    const doc = loadYaml(TEXT) as Doc;
    expect(doc.openapi).toMatch(/^3\./);
    expect(typeof doc.info.version).toBe('string');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    const schemas = doc.components['schemas'] ?? {};
    const notObjects = Object.entries(schemas)
      .filter(([, v]) => v === null || typeof v !== 'object')
      .map(([k]) => k);
    // 变更记录混进 schemas 时，会以"一个名字很长的字符串 schema"出现在这里
    expect(notObjects).toEqual([]);
  });

  it('当前版本号在 info.description 的变更记录里有对应条目（变更记录写对了地方）', () => {
    const doc = loadYaml(TEXT) as Doc;
    expect(doc.info.description).toContain(`${doc.info.version}（`);
  });

  it('所有 $ref 都能解析到 components 里的真实条目', () => {
    const doc = loadYaml(TEXT) as Doc;
    const refs: string[] = [];
    collectRefs(doc, refs);
    const dangling = [...new Set(refs)].filter((ref) => {
      const m = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
      if (m === null) return true;
      const [, section, name] = m;
      return doc.components[section ?? '']?.[name ?? ''] === undefined;
    });
    expect(dangling).toEqual([]);
    expect(refs.length).toBeGreaterThan(20); // 防空跑：确实扫到了引用
  });

  it('行正则抽出的路由集合 == 真解析器抽出的路由集合（routes.contract 比对的前提）', () => {
    const doc = loadYaml(TEXT) as Doc;
    const real = Object.entries(doc.paths)
      .flatMap(([path, ops]) =>
        Object.keys(ops)
          .filter((m) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m))
          .map((m) => `${m.toUpperCase()} ${normalizeRoutePath(path)}`),
      )
      .sort();
    const byLine = parseContractRoutes(TEXT)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(byLine).toEqual(real);
  });
});

/**
 * 契约里声明的**输入上限**必须与代码里的常量一致（B7 / AJ-191 起）。
 *
 * @why 契约写 `maxLength: 500` 而代码拒 200，是"契约比实现宽松"的同一类漂移：
 *      前端照契约放行、服务端照代码拒绝，运营看到的是"填了、点了、报参数错误"。
 *      而这类漂移不会让任何既有测试变红——上限是**新增**的，没有旧用例覆盖它。
 * @why 从 yaml 里**读出来**与常量比，而不是断言 `maxLength === 500`：
 *      后者在契约里再写一个 500 就绿了，等于两头各自写死、互相不认识。
 */
describe('契约的输入上限与 shared 常量一致', () => {
  /** 取某个路径下某个方法请求体的 properties。 */
  function requestProps(path: string, method: string): Record<string, Record<string, unknown>> {
    const doc = loadYaml(TEXT) as Doc;
    const op = (doc.paths[path] as Record<string, Record<string, unknown>> | undefined)?.[
      method
    ] as
      | { requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> } }
      | undefined;
    const schema = op?.requestBody?.content?.['application/json']?.schema;
    const props = (schema as { properties?: Record<string, Record<string, unknown>> } | undefined)
      ?.properties;
    expect(props, `${method.toUpperCase()} ${path} 没有请求体 properties`).toBeDefined();
    return props ?? {};
  }

  it('POST /admin/orders/{id}/refund 的 reason.maxLength == REFUND_REASON_MAX_LENGTH', () => {
    const reason = requestProps('/admin/orders/{id}/refund', 'post')['reason'];
    expect(reason, '契约没有声明 reason').toBeDefined();
    expect(reason?.['maxLength']).toBe(REFUND_REASON_MAX_LENGTH);
  });

  // @why 不用 "JSON.stringify 里包含 128" 那种包含式断言：128 在别处也可能出现，
  //      那种写法在契约把 maxLength 删掉之后仍然可能绿（§2 第 49 条：扫描型断言最易自证）。
  it('IdemKey 参数的 maxLength == MAX_CLIENT_KEY_LENGTH（0.6.0② 的同类防线）', () => {
    const doc = loadYaml(TEXT) as Doc;
    const idem = doc.components['parameters']?.['IdemKey'] as
      { schema?: { maxLength?: number } } | undefined;
    expect(idem, 'components.parameters.IdemKey 不存在').toBeDefined();
    expect(idem?.schema?.maxLength).toBe(MAX_CLIENT_KEY_LENGTH);
  });
});
