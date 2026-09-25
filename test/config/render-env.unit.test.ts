/**
 * 职责：`render.yaml` ↔ 配置 schema 的**三项一致性**（F16 部署底座的守卫）。
 *
 * @why 部署配置最危险的一类失效不是"配错了值"，而是"**平台上的清单和代码对不上**"，
 *      而且两个方向都不会报错：
 *      ① **漏配**：代码新增了一个必填变量，平台上没配 → 本机永远发现不了（本机 `.env` 里有），
 *         只在**部署之后启动失败**时才暴露，那时已经是一次失败的发布；
 *         更糟的是失败形态是"服务起不来"，排查时最容易误判成代码问题。
 *      ② **拼错**：平台上写了 `JWT_SECRECT` → zod 默认 strip 未知键，
 *         **静默忽略**并回落到默认值（@see server/src/config.ts @limitation 一）。
 *         服务照样起来，密钥却是最初的那个——这类"看起来一切正常"的错最难发现。
 *      ③ **密钥进仓库**：`render.yaml` 是提交进仓库的文件，给它写一个 `value: sk_live_...`
 *         等于把密钥交给所有能读仓库的人（含 CI 日志）。
 *      这三类都不是 bug，是"人对不上清单"，所以只能靠集合比对自动兜住。
 *
 * @how 纯 fs + 极简行解析：只认我们自己写的那一种缩进风格（`- key: X` + 缩进属性行），
 *      不引 YAML 依赖（`js-yaml` 在当前只是**间接依赖**，依赖它等于把门禁挂在别人的依赖树上）。
 *
 * @limitation 一：解析器只认 `- key: X` 这一种写法；换成内联流式的 YAML 会扫不到。
 *              @why 扫不到会立刻表现为"范围断言红"（里头必须含 `NODE_ENV`），
 *              不会静默变绿——这是刻意的设计：**让解析器失效以红灯的形式暴露**。
 * @limitation 二：只比对**键名**，不比对取值范围与是否合理（例如 `plan` 是不是该用 starter）；
 *              后者是人的判断，机器只能保证"没漏、没拼错、没把密钥写进来"。
 * @limitation 三：`REQUIRED_ENV_KEYS` 的判据是"单字段能否接受 undefined"，不含跨字段规则
 *              （"生产启用 stripe 时 CHECKOUT_BASE_URL 必填"那一类）。
 *              那几条的组合依赖其它字段的取值，无法离线枚举，靠 `config.unit.test.ts` 覆盖。
 *
 * @see ../../render.yaml；../../server/src/config.ts；docs/地基搭建清单.md F16
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, REQUIRED_ENV_KEYS, SECRET_KEYS } from '../../server/src/config.js';

const root = resolve(import.meta.dirname, '../..');
const renderYaml = readFileSync(resolve(root, 'render.yaml'), 'utf8');

/**
 * 平台上写、但**不由应用 schema 读取**的变量白名单。
 * @why 每条都必须写清原因，否则白名单会变成"懒得解释"的垃圾桶，机制就失效了。
 */
const PLATFORM_KEYS: Readonly<Record<string, string>> = {
  NODE_VERSION: 'Render 平台的运行时版本开关，由平台自身读取，不属于应用配置',
};

interface EnvEntry {
  key: string;
  /** 这一条是否带了字面量 `value:`（密钥类绝不允许）。 */
  literal: boolean;
}

/**
 * 抽出 `render.yaml` 里声明的环境变量（`envVars` 的 `- key: …` 条目）。
 * @see @limitation 一
 */
function parseEnvEntries(yaml: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  let inEnv = false;
  let current: EnvEntry | undefined;
  for (const raw of yaml.split('\n')) {
    // 顶格 = 顶层结构键（`services:` / `databases:`）→ 环境变量段结束
    if (/^\S/.test(raw)) {
      inEnv = false;
      current = undefined;
      continue;
    }
    if (/^\s*envVars:\s*$/.test(raw)) {
      inEnv = true;
      current = undefined;
      continue;
    }
    // ⚠️ 只收 `envVars` 段里的条目：`databases` 段里的 `- name:` 之类不是环境变量
    //    （这是自检逼出来的——第一版不分段，把 `databases` 下的条目也收进来了）
    const head = /^\s*-\s*key:\s*([A-Za-z0-9_]+)\s*$/.exec(raw);
    if (head && inEnv) {
      current = { key: head[1] as string, literal: false };
      out.push(current);
      continue;
    }
    if (current !== undefined && /^\s+value:/.test(raw)) current.literal = true;
  }
  return out;
}

const declared = parseEnvEntries(renderYaml);
const declaredKeys = new Set(declared.map((e) => e.key));

describe('render.yaml ↔ 配置 schema 一致', () => {
  it('两边都非空，且含各自最关键的那几个键（防"空对空"永远绿）', () => {
    // @why 本项目第三次以上踩同一形态：解析失效 / 目录改名会让集合变空，
    //      于是下面的"没有缺项""没有拼错"全部永真。钉住真实存在的锚点键。
    expect(REQUIRED_ENV_KEYS.length).toBeGreaterThan(0);
    expect(REQUIRED_ENV_KEYS).toContain('DATABASE_URL');
    expect(REQUIRED_ENV_KEYS).toContain('JWT_SECRET');
    expect(declaredKeys.size).toBeGreaterThan(10);
    expect(declaredKeys.has('NODE_ENV')).toBe(true);
  });

  it('每个"无默认值"的变量都在 render.yaml 里声明了（漏配 = 部署后启动失败）', () => {
    const missing = REQUIRED_ENV_KEYS.filter((k) => !declaredKeys.has(k));
    expect(
      missing,
      `这些变量没有默认值、部署时却没配（本机 .env 里有，平台上没有 → 部署后才炸）：\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('render.yaml 里每个键都被配置层认得（拼错会被 zod 静默忽略）', () => {
    const unknown = [...declaredKeys].filter(
      (k) => !CONFIG_KEYS.includes(k) && PLATFORM_KEYS[k] === undefined,
    );
    expect(
      unknown,
      `这些键配置层不认识（zod 默认 strip 未知键 → 配了等于没配，且不报错）：\n${unknown.join('\n')}`,
    ).toEqual([]);
  });

  it('白名单里的键确实只属于平台（防止白名单写错而永久放水）', () => {
    for (const key of Object.keys(PLATFORM_KEYS)) {
      expect(declaredKeys.has(key), `${key} 已不在 render.yaml 里，白名单该删了`).toBe(true);
      expect(CONFIG_KEYS).not.toContain(key);
    }
  });

  it('NODE_ENV 必须显式写 production（schema 默认值是 development，漏配则生产校验全部不生效）', () => {
    // @why 这一条单独拎出来是因为它的失效形态特别隐蔽：
    //      服务**照样起得来、照样能下单**，只是 `crossField` 里所有 `isProd` 规则都不跑——
    //      https 要求、必填要求、CORS 要求全跳过。表现为"生产环境比预发宽松"，且没人会觉得是配置丢了。
    const entry = declared.find((e) => e.key === 'NODE_ENV');
    expect(entry).toBeDefined();
    expect(entry?.literal).toBe(true);
    expect(/^\s*value:\s*production\s*$/m.test(renderYaml)).toBe(true);
  });

  it('密钥类变量不得在 render.yaml 里写字面值（本文件进仓库，写了等于泄露）', () => {
    // ⚠️ 放宽成 `readonly string[]` 是**故意**的：`SECRET_KEYS` 是字面量元组（`as const`），
    //    用它去 `.includes()` 一个 `string` 是类型错误——但这里要查的是"任意键是不是密钥"，
    //    本来就是运行时判断。元组类型保护的是"新增密钥必须写进名单"那一侧，不是这一侧。
    const secretKeys: readonly string[] = SECRET_KEYS;
    const leaked = declared
      .filter((e) => secretKeys.includes(e.key) && e.literal)
      .map((e) => e.key);
    expect(
      leaked,
      `这些是密钥，却带了字面 value（应改成 sync: false 并在控制台填）：\n${leaked.join('\n')}`,
    ).toEqual([]);
  });

  it('解析器自检：键、字面值标记、段落边界都解析正确（防"解析器坏了 → 全绿"）', () => {
    // @why 上面六条全部依赖 parseEnvEntries。它一旦写坏（或 YAML 换了写法），
    //      最可能的后果不是报错，而是**扫出空集合 → 所有断言永真**。
    //      所以必须对解析器本身做一次红灯能力验证。
    const sample = [
      'services:',
      '  - type: web',
      '    envVars:',
      '      - key: NODE_ENV',
      '        value: production',
      '      - key: JWT_SECRET',
      '        sync: false',
      '      - key: DATABASE_URL',
      '        fromDatabase:',
      '          name: waselect-pg',
      'databases:',
      '  - name: waselect-pg',
      '      - key: NOT_IN_ENV_SECTION',
      '        value: should-not-appear',
    ].join('\n');
    const parsed = parseEnvEntries(sample);
    expect(parsed.map((e) => e.key)).toEqual(['NODE_ENV', 'JWT_SECRET', 'DATABASE_URL']);
    expect(parsed.map((e) => e.literal)).toEqual([true, false, false]);
  });
});
