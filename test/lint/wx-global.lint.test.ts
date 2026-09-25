/**
 * 职责：断言「小程序端禁止直接引用宿主全局 `wx`」这条 ESLint 规则**真的生效**（F14 第一单元）。
 *
 * @why 规则生效的表现是"全仓没有违规"——而"规则被删掉"的表现**一模一样**（也是全绿）。
 *      两者无法从 `npm run lint` 的退出码上区分，所以必须有一个永远违规的夹具：
 *      规则在，它红（被 disable 压住）；规则没了，它一声不吭。
 *      这是本项目"门禁的门禁"的第三条实例（前两条：类型感知规则 AJ-3、分层规则 AJ-43）。
 *
 * @how 夹具里的违规都带内联 `eslint-disable`，因此不进 `messages`（全仓 lint 保持 0 错），
 *      只在 `suppressedMessages` 里出现。断言"规则报了 2 条"且"未压住的是 0 条"。
 *
 * @tradeoff 放在 **lint 层**而不是 unit 层：实测它要跑 5 秒（第二条要 lint 整个 miniprogram
 *          目录，其中的 .ts 会触发类型感知配置建 TS Program）。放进 unit 层会把 2 秒的快反馈
 *          环拖到 7 秒，代价远大于收益；lint 层本来就是"慢但必须跑"的地方（与 type-aware 同理）。
 *          ⚠️ 夹具故意用 `.js`：它不需要类型感知，且只在 miniprogram/ 下才会被本规则命中。
 */
import { ESLint } from 'eslint';
import { relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const RULE = 'no-restricted-globals';
const FIXTURE = 'miniprogram/utils/wx-global.fixture.js';

describe('F14：禁止直接使用宿主全局 wx', () => {
  it('夹具里的两处 `wx.*` → 规则必须报（被 disable 压住，未压住者为 0）', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
    const results = await eslint.lintFiles([FIXTURE]);

    const hit = results.find((r) => relative(root, r.filePath).split(sep).join('/') === FIXTURE);
    expect(hit, `没 lint 到 ${FIXTURE}——夹具被改名或移走了`).toBeDefined();

    const reported = hit?.messages.filter((m) => m.ruleId === RULE).length ?? 0;
    const suppressed = hit?.suppressedMessages.filter((m) => m.ruleId === RULE).length ?? 0;

    expect(suppressed, `${RULE} 没有报——规则被删掉或 glob 不再命中 miniprogram`).toBe(2);
    // 夹具里的违规必须**全部**被压住，否则 npm run lint 会红
    expect(reported).toBe(0);
  });

  it('反向：真实业务文件里没有未压住的 `wx` 引用（守卫"有人绕过封装"）', async () => {
    // @why 与上一条成对（只测"违规会红"会被一条"禁止一切"的规则骗过）：
    //      真正的业务文件（request.js / app.js）现在必须**零违规**，
    //      否则说明有人绕开了 wx-api 封装——那正是本单元要消灭的形态。
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
    const results = await eslint.lintFiles(['miniprogram/**/*.js', 'miniprogram/**/*.ts']);
    const offenders = results
      .filter((r) => !r.filePath.includes('fixture'))
      .flatMap((r) => r.messages.filter((m) => m.ruleId === RULE))
      .map((m) => m.message);
    expect(offenders).toEqual([]);
  });
});
