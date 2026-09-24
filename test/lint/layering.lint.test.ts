/**
 * 职责：断言**分层依赖方向真的被 ESLint 拦住**（R2-1 / F10 的验收第一条）。
 *
 * @why 这是"架构约束的门禁"。约定写在文档里、写在 CLAUDE.md 里都没用——
 *      三个月后有人在 domain 里 `import Stripe`，一切都还"能跑"，
 *      直到要换支付通道时才发现业务核心已经和具体机构焊死了。
 *      那条 import 当时就该是红的。
 *
 * @how 与 A5 的类型感知测试同一套路：夹具里的违规都带内联 disable，
 *      所以不进 `messages`（`npm run lint` 保持绿），只在 `suppressedMessages` 里出现。
 *      断言"规则报了"，而不是"CLI 输出是 0 行"——后者分不清"规则生效"与"规则被删"。
 *
 * @why 还要断言**合法路径不被拦**：只测"违规会红"的门禁，
 *      会被一条"禁止一切跨目录 import"的规则轻松骗过（全绿，但代码没法写了）。
 *      合法与非法必须成对断言。
 *
 * @limitation 一是**形态**检查，不是架构审查：它能挡住"import 了不该 import 的目录"，
 *              挡不住"把适配器逻辑写进 domain 目录里"（那是 review 的事）。
 * @limitation 二：只对 `server/src` 与 `test/lint/layering` 两套目录生效
 *              （后者是夹具树，与前者共用同一份规则定义，见 eslint.config.mjs 的 LAYERING_BLOCKS）。
 *
 * @see docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md §4；docs/基座缺陷修复方案-2026-09-23.md R2-1
 */
import { ESLint } from 'eslint';
import { relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const FIXTURE_DIR = 'test/lint/layering';
const RULE = 'no-restricted-imports';

interface LintByFile {
  /** 相对仓库根的路径 → 该文件的报错统计 */
  get(rel: string): { reported: number; suppressed: number } | undefined;
}

async function lintTree(): Promise<LintByFile> {
  const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
  const results = await eslint.lintFiles([`${FIXTURE_DIR}/**/*.ts`]);
  const map = new Map<string, { reported: number; suppressed: number }>();
  for (const r of results) {
    const rel = relative(root, r.filePath).split(sep).join('/');
    map.set(rel, {
      reported: r.messages.filter((m) => m.ruleId === RULE).length,
      suppressed: r.suppressedMessages.filter((m) => m.ruleId === RULE).length,
    });
  }
  return { get: (rel) => map.get(rel) };
}

describe('F10 分层依赖方向（R2-1）', () => {
  it('domain 反向依赖 adapters / app / 框架 / 驱动 → 规则必须报（4 条）', async () => {
    const hit = (await lintTree()).get(`${FIXTURE_DIR}/domain/violations.fixture.ts`);
    expect(hit?.suppressed, `${RULE} 没有报——分层规则被改坏或删掉了`).toBe(4);
    // 违规都被内联 disable 压住：未压住的报错必须为 0，否则 npm run lint 会红
    expect(hit?.reported).toBe(0);
  });

  it('ports 反向依赖 adapters / domain / app → 规则必须报（3 条）', async () => {
    const hit = (await lintTree()).get(`${FIXTURE_DIR}/ports/violations.fixture.ts`);
    expect(hit?.suppressed).toBe(3);
    expect(hit?.reported).toBe(0);
  });

  it('adapters 反向依赖 app → 规则必须报（1 条）', async () => {
    const hit = (await lintTree()).get(`${FIXTURE_DIR}/adapters/violations.fixture.ts`);
    expect(hit?.suppressed).toBe(1);
    expect(hit?.reported).toBe(0);
  });

  /**
   * 反向断言：合法路径一条都不许报。
   * @why 没有这条，把规则写成"禁止所有跨目录 import"同样能让上面三条全绿——
   *      那是最容易被忽略的一种假绿：门禁越严越好，直到没人能写代码。
   */
  it('合法路径不被拦：domain→ports、adapters→ports、app→domain/adapters 全部 0 条', async () => {
    const byFile = await lintTree();
    for (const rel of [
      `${FIXTURE_DIR}/domain/pricing.fixture.ts`,
      `${FIXTURE_DIR}/adapters/stripe-adapter.fixture.ts`,
      `${FIXTURE_DIR}/app/assemble.fixture.ts`,
      `${FIXTURE_DIR}/ports/payment-port.fixture.ts`,
      `${FIXTURE_DIR}/app/app-token.fixture.ts`,
    ]) {
      const hit = byFile.get(rel);
      expect(hit, `没 lint 到 ${rel}（目录或 ignore 配置变了？）`).toBeDefined();
      expect(hit?.suppressed, `${rel} 被误拦`).toBe(0);
      expect(hit?.reported, `${rel} 有未压住的报错`).toBe(0);
    }
  });

  /**
   * 规则必须对**真实代码树**生效，不能只管夹具树。
   *
   * @why 夹具与真代码共用同一份规则定义（eslint.config.mjs 的 LAYER_ROOTS.flatMap），
   *      但"共用"这件事本身没有强制器：把 `server/src` 从 LAYER_ROOTS 里删掉，
   *      上面四条**依然全绿**——夹具照旧被拦，而真代码彻底裸奔。
   *      这是最容易发生的假绿：改配置时只顾着让测试过。
   *      所以这里直接问 ESLint："给 server/src/domain 下某个文件算出来的配置里有没有这条规则"。
   * @limitation 验的是"规则挂上了"，不验"规则内容对不对"——后者由上面对夹具的断言覆盖。
   */
  it('真实代码树（server/src）也算得出这条规则（防止只配了夹具树）', async () => {
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
    for (const layer of ['domain', 'ports', 'adapters']) {
      // 路径不必真实存在：calculateConfigForFile 只做配置匹配，不读文件
      const cfg = await eslint.calculateConfigForFile(
        resolve(root, 'server/src', layer, 'probe.ts'),
      );
      expect(
        cfg.rules?.['no-restricted-imports'],
        `server/src/${layer} 没有挂上依赖方向规则`,
      ).toBeDefined();
    }
    // app 是组装层：它**不该**被这条规则限制（否则没法注入实现）
    const appCfg = await eslint.calculateConfigForFile(resolve(root, 'server/src/app/probe.ts'));
    expect(appCfg.rules?.['no-restricted-imports']).toBeUndefined();
  });

  it('夹具树整体没有其它规则的报错（否则 npm run lint 会红）', async () => {
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
    const results = await eslint.lintFiles([`${FIXTURE_DIR}/**/*.ts`]);
    const others = results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.ruleId}`));
    expect(others).toEqual([]);
  });
});
