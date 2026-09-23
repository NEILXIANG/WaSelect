/**
 * 职责：断言 ESLint 的**类型感知规则真的在起作用**（A5）。
 *
 * @why 这是"门禁的门禁"。`npm run lint` 全绿有两种可能：规则生效且代码干净、
 *      或者规则压根没挂上——两者从 CLI 输出看一模一样，都是 0 行。
 *      而这类规则一旦被误删，要等到线上漏掉一个未 await 的 Promise 才会被发现，
 *      那时没人会联想到"是不是 lint 配置没了"。
 *
 * @how 用 ESLint 的 Node API 去 lint `type-aware.fixture.ts`，读 `suppressedMessages`
 *      （夹具里的违规都带内联 disable，所以不进 `messages`、也不会让 `npm run lint` 变红）。
 *      断言三条规则的 ruleId 都在里面——即"它们确实报了，只是被夹具自己压住了"。
 *
 * @limitation 一：跑一次要建 TS Program（~15s），所以放在**独立的 lint project**，
 *              不进 `test:unit`——快反馈环里不该为它买单。它只在 `npm run gate` 里跑。
 * @limitation 二：这里验的是"规则会报"，不是"全仓没有违规"——后者由 `npm run lint` 自己负责。
 *              两者缺一不可：只验前者会漏掉真实违规，只跑后者会漏掉规则被删。
 */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const FIXTURE = 'test/lint/type-aware.fixture.ts';

async function lint(): Promise<{ reported: string[]; suppressed: string[] }> {
  const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
  const results = await eslint.lintFiles([FIXTURE]);
  expect(results.length, `没 lint 到 ${FIXTURE}（路径或 ignore 配置变了？）`).toBe(1);
  const [result] = results;
  if (result === undefined) throw new Error('unreachable');
  return {
    reported: result.messages.map((m) => String(m.ruleId)),
    suppressed: result.suppressedMessages.map((m) => String(m.ruleId)),
  };
}

describe('ESLint 类型感知规则（A5）', () => {
  it('三条规则都挂上了：夹具的违规确实被它们报出来', async () => {
    const { suppressed } = await lint();
    for (const rule of [
      '@typescript-eslint/no-floating-promises',
      '@typescript-eslint/no-misused-promises',
      '@typescript-eslint/switch-exhaustiveness-check',
    ]) {
      expect(suppressed, `${rule} 没有报——A5 block 被改坏或删掉了`).toContain(rule);
    }
  });

  it('夹具自身不产生未压住的错误（否则 npm run lint 会红，说明漏写了 disable）', async () => {
    const { reported } = await lint();
    expect(reported).toEqual([]);
  });

  /**
   * 反向断言：钉住"别为 Express 关掉 checksVoidReturn.arguments"。
   * @why 直觉上 async handler 会被 `no-misused-promises` 误报，于是有人会去关 arguments；
   *      实测 @types/express 5 的签名本来就允许，关了只会白白放过
   *      `arr.forEach(async …)` 这类真正吞错误的写法。这条断言防止那个"好心办坏事"的改动。
   */
  it('Express 5 的 async handler 不被误报（证明不必关 checksVoidReturn.arguments）', async () => {
    const { suppressed } = await lint();
    // 夹具里 async handler 那一行**没有** disable 指令，
    // 所以它既不该出现在 reported（会 lint 红），也不该出现在 suppressed。
    expect(suppressed.filter((r) => r === '@typescript-eslint/no-misused-promises').length).toBe(1);
  });
});
