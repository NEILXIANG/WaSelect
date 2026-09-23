/**
 * 职责：`.env.example` ↔ 配置 schema 的**键集合一致性**（契约层测试）。
 *
 * @why 这是防复发机制，不是功能测试。zod 默认 strip 未知键，导致两类漂移都**静默**：
 *      ① 文档写了 `HOST=`，schema 里没有 → 配了等于没配，且拼错也不报错（真实发生过，见 config.ts HOST 的 @why）；
 *      ② schema 里有某键，文档没写 → 部署时没人知道要配它，表现为"启动失败"或"用了默认值"。
 *      这两类都不是 bug，是"人对不上文档"，所以只能靠集合比对自动兜住。
 *
 * @limitation 只比对**键名**，不比对默认值与取值范围——后者靠 config.unit.test.ts 的用例覆盖。
 *
 * @see docs/地基搭建清单.md F3；server/src/config.ts @limitation 一
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from './config.js';

const root = resolve(import.meta.dirname, '../..');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
const documented = new Set(
  [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string),
);

/**
 * 文档里写了、但**不进服务端配置**的变量白名单。
 * @why 每一条都必须写清原因，否则白名单会变成"懒得解释"的垃圾桶，机制就失效了。
 *      这里的两条是**测试基础设施**用的，由 test/db/test-db.ts 直接读 process.env——
 *      它们不该出现在服务端运行配置里（会让生产配置多出两个无意义的键）。
 */
const TEST_ONLY_KEYS: Readonly<Record<string, string>> = {
  TEST_DATABASE_URL: '测试库连接串，由 test/db/test-db.ts 读取，不属于服务端运行配置',
  TEST_ADMIN_DB_URL: '建测试库用的管理库连接串，同上',
};

describe('.env.example ↔ 配置 schema 键集合一致', () => {
  it('文档里出现的变量，代码必须认识（否则配了等于没配，且拼错不报错）', () => {
    const unknown = [...documented].filter(
      (k) => !CONFIG_KEYS.includes(k) && TEST_ONLY_KEYS[k] === undefined,
    );
    expect(unknown).toEqual([]);
  });

  it('代码认识的变量，文档必须写出来（否则部署时没人知道要配）', () => {
    const undocumented = CONFIG_KEYS.filter((k) => !documented.has(k));
    expect(undocumented).toEqual([]);
  });

  it('白名单里的键确实在文档中且确实不在 schema 中（防止白名单名写错而永久失效）', () => {
    for (const key of Object.keys(TEST_ONLY_KEYS)) {
      expect(documented.has(key)).toBe(true);
      expect(CONFIG_KEYS).not.toContain(key);
    }
  });

  it('两边都非空——防止正则或 schema 解析失效后测试"空对空"通过', () => {
    expect(CONFIG_KEYS.length).toBeGreaterThan(30);
    expect(documented.size).toBeGreaterThan(30);
  });
});
