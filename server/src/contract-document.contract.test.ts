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
