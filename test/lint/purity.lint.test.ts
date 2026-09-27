/**
 * 职责：断言「业务侧不得直接取时间 / 摇随机数」这条规则**真的在起作用**（F10 最后一项）。
 *
 * @why 端口（Clock / IdGen）只提供"可以用"，不提供"不可以用别的"。
 *      把两个端口接好之后的第二天，有人在业务代码里写了一句 `new Date()`，
 *      一切照常工作、照常上线，直到某天发现"日本时间早上 9 点前下的单，单号日期是昨天"。
 *      这条门禁让那句 `new Date()` 在**写下的那一刻**就是红的。
 *
 * @how 与分层门禁（test/lint/layering.lint.test.ts）同一套路：
 *      夹具违规带内联 disable → 不进 `messages`（npm run lint 保持绿），
 *      只在 `suppressedMessages` 里出现；断言"规则报了"，而不是"输出是 0 行"。
 *
 * @why 还要断言**豁免清单真的只豁免了那几处**：豁免写宽了（比如顺手把 `app/**` 全免）
 *      同样能让下面所有断言全绿，而规则实际已经名存实亡——
 *      所以这里逐个问 ESLint："给这个路径算出来的配置里有没有这条规则"。
 *
 * @limitation 只管**形态**（有没有直接调这几个 API），不管语义：
 *              把"取当前时间"包进一个叫 `currentTime()` 的函数再放 adapters 里，
 *              这条规则一条都不会报——那是 review 的事。
 */
import { ESLint } from 'eslint';
import { relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const FIXTURE_DIR = 'test/lint/purity';
const RULE = 'no-restricted-syntax';

interface LintByFile {
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

/** 某个路径算出来的配置里有没有这条规则（路径不必真实存在）。 */
async function configHasRule(rel: string): Promise<boolean> {
  const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
  const cfg = await eslint.calculateConfigForFile(resolve(root, rel));
  return cfg.rules?.[RULE] !== undefined;
}

describe('F10 时间与随机源纯度（业务侧不得直连全局）', () => {
  it('五种违规写法全部被规则报（5 条）', async () => {
    const hit = (await lintTree()).get(`${FIXTURE_DIR}/violations.fixture.ts`);
    expect(hit?.suppressed, `${RULE} 没有报——纯度规则被改坏或删掉了`).toBe(5);
    // 违规都被内联 disable 压住：未压住的必须为 0，否则 npm run lint 会红
    expect(hit?.reported).toBe(0);
  });

  it('注入形态一条都不报（合法路径不被拦）', async () => {
    const hit = (await lintTree()).get(`${FIXTURE_DIR}/legal.fixture.ts`);
    expect(hit, '没 lint 到合法夹具（目录或 ignore 配置变了？）').toBeDefined();
    expect(hit?.suppressed).toBe(0);
    expect(hit?.reported).toBe(0);
  });

  it('真实业务路径受约束（含**将来**才会出现的目录，fail-closed）', async () => {
    // `routes/` 现在还不存在：这条断言的意义是"将来新建业务目录时默认受约束"
    for (const rel of [
      'server/src/main.ts',
      'server/src/domain/probe.ts',
      'server/src/routes/orders.ts',
    ]) {
      expect(await configHasRule(rel), `${rel} 没有挂上纯度规则`).toBe(true);
    }
  });

  it('豁免清单**只有**写明理由的那几处（多豁免一处就等于没有规则）', async () => {
    for (const rel of [
      'server/src/adapters/probe.ts',
      'server/src/logger.ts',
      'server/src/context.ts',
      'server/src/app/auth.ts',
    ]) {
      expect(await configHasRule(rel), `${rel} 不应被纯度规则约束（豁免清单被改窄了）`).toBe(false);
    }
    // 测试文件豁免：它们正是要用固定/随机时间去覆盖边界
    expect(await configHasRule('server/src/domain/order-no.unit.test.ts')).toBe(false);
  });

  it('夹具树整体没有其它规则的报错（否则 npm run lint 会红）', async () => {
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
    const results = await eslint.lintFiles([`${FIXTURE_DIR}/**/*.ts`]);
    const others = results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.ruleId}`));
    expect(others).toEqual([]);
  });
});
