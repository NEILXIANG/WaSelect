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
import {
  REFUND_REASON_MAX_LENGTH,
  SEARCH_KEYWORD_MAX_LENGTH,
  SHIP_MAX_CHARS,
} from '@waselect/shared';
import { MAX_CLIENT_KEY_LENGTH } from './ports/idempotency.js';
import { ADDRESS_MAX_CHARS } from './domain/address-input.js';
import { MAX_QUOTE_ITEMS } from './domain/quote.js';
import { WECHAT_CODE_MAX_LENGTH } from './app/wechat-auth-routes.js';
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

  /** 取某个路径下某个方法的**查询参数**（按 name；与 requestProps 同口径：从 yaml 读出来）。 */
  function queryParam(
    path: string,
    method: string,
    name: string,
  ): { maxLength?: number } | undefined {
    const doc = loadYaml(TEXT) as Doc;
    const op = (doc.paths[path] as Record<string, Record<string, unknown>> | undefined)?.[
      method
    ] as { parameters?: Array<{ name?: string; schema?: { maxLength?: number } }> } | undefined;
    return op?.parameters?.find((p) => p.name === name)?.schema;
  }

  /**
   * AJ-360：`keyword` 是**唯一**一个原样进 `ILIKE '%kw%'` 的客户端可控输入（CAT2-07），
   * 且公开 `/products`（不鉴权、不限流）与管理端 `/admin/orders` **两处**都没有上限。
   * 只钉一处的话，另一处就是"契约没写、实现没挡"的同形状漏洞——故**两处都比**。
   */
  it('GET /products 与 GET /admin/orders 的 keyword.maxLength == SEARCH_KEYWORD_MAX_LENGTH', () => {
    for (const path of ['/products', '/admin/orders']) {
      const kw = queryParam(path, 'get', 'keyword');
      expect(kw, `${path} 没有声明 keyword 参数`).toBeDefined();
      expect(kw?.maxLength, `${path} 的 keyword.maxLength`).toBe(SEARCH_KEYWORD_MAX_LENGTH);
    }
  });

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

  /**
   * AJ-315：发货两列是 VARCHAR(32)/(64)，契约原先**只写 required**，连 maxLength 都没有。
   * 与上面 reason 那条同口径——从 yaml 读出来与 shared 常量比，两头各自写死不算数。
   */
  it('POST /admin/orders/{id}/ship 的 carrier / tracking_no maxLength == SHIP_MAX_CHARS', () => {
    const props = requestProps('/admin/orders/{id}/ship', 'post');
    expect(props['carrier']?.['maxLength']).toBe(SHIP_MAX_CHARS.carrier);
    expect(props['tracking_no']?.['maxLength']).toBe(SHIP_MAX_CHARS.tracking_no);
  });

  /**
   * AJ-316：`code` 的上限 128 **只存在于路由文件里**，若契约另写一个数就成两份真源。
   * 无鉴权入口的上限尤其不能漂：契约比实现宽松时，前端照契约放行、服务端照代码拒绝。
   */
  it('POST /auth/wechat/login 的 code.maxLength == WECHAT_CODE_MAX_LENGTH', () => {
    const code = requestProps('/auth/wechat/login', 'post')['code'];
    expect(code, '契约没有声明 code').toBeDefined();
    expect(code?.['maxLength']).toBe(WECHAT_CODE_MAX_LENGTH);
  });

  /**
   * AJ-319：这一条是**先有契约、后有实现**——核对时发现代码里根本没有 items 数量上限
   * （唯一约束是 JSON_BODY_LIMIT）。钉住它，防止将来把常量改了而契约不跟。
   */
  it('OrderItemsInput.maxItems == MAX_QUOTE_ITEMS', () => {
    const doc = loadYaml(TEXT) as Doc;
    const items = doc.components['schemas']?.['OrderItemsInput'] as
      { maxItems?: number } | undefined;
    expect(items, 'components.schemas.OrderItemsInput 不存在').toBeDefined();
    expect(items?.maxItems).toBe(MAX_QUOTE_ITEMS);
  });

  /** DB2-04：地址各字段上限逐字段比对（ADDRESS_MAX_CHARS 是唯一真源）。 */
  it('AddressInput 各字段 maxLength == ADDRESS_MAX_CHARS', () => {
    const doc = loadYaml(TEXT) as Doc;
    const addr = doc.components['schemas']?.['AddressInput'] as
      { properties?: Record<string, { maxLength?: number }> } | undefined;
    expect(addr?.properties, 'components.schemas.AddressInput 不存在').toBeDefined();
    for (const [field, max] of Object.entries(ADDRESS_MAX_CHARS)) {
      expect(
        addr?.properties?.[field]?.maxLength,
        `AddressInput.${field} 的 maxLength 与 ADDRESS_MAX_CHARS 不一致`,
      ).toBe(max);
    }
  });
});
