/**
 * 职责：**故意违规**的夹具——业务侧直接取时间 / 摇随机数的五种写法。
 *
 * @why 每条违规都带内联 disable：这样 `npm run lint` 保持绿，
 *      而 `test/lint/purity.lint.test.ts` 断言的是 `suppressedMessages`
 *      ——断言"规则报了"而不是"CLI 输出 0 行"，后者分不清"规则生效"与"规则被删"。
 * @limitation 改动这里的**条数**必须同步改那边断言的数字：
 *             数字写死的代价是"加一条违规忘记改断言"，收益是"规则整体失效时立刻红"。
 */
import { randomUUID } from 'node:crypto';
import { randomOrderSeq } from '@waselect/shared';

export function violations(): string[] {
  // eslint-disable-next-line no-restricted-syntax
  const at = new Date();
  // eslint-disable-next-line no-restricted-syntax
  const ms = Date.now();
  // eslint-disable-next-line no-restricted-syntax
  const id = randomUUID();
  // eslint-disable-next-line no-restricted-syntax
  const rnd = Math.random();
  // eslint-disable-next-line no-restricted-syntax
  const seq = randomOrderSeq();
  return [at.toISOString(), String(ms), id, String(rnd), seq];
}
