/**
 * 职责：覆盖率闸门的**唯一事实来源**（阈值表 + 统计范围）。
 *
 * @why 单独成文件而不是写在 `vitest.config.mts` 里：阈值是需要被**验证**的数据。
 *      `test/config/coverage-threshold.unit.test.ts` 要断言"每条阈值都还命中真实文件"，
 *      而 `.mts` 无法被类型检查的测试文件直接 import（TS5097 要求 `allowImportingTsExtensions`，
 *      而该选项与 build 配置的 `noEmit: false` 冲突）。抽成 `.ts` 之后，
 *      配置（esbuild 直接解析 `.ts`）与测试（按 NodeNext 写 `.js`，解析到本文件）各取所需。
 *
 * @limitation 配置侧用 `'./vitest.coverage-gates.ts'`、测试侧用 `'../../vitest.coverage-gates.js'`
 *              ——同一个文件两种写法，看着不一致，但各自在自己的解析规则下才是正确的。
 *              两边的解析链不同（vite 配置加载走 esbuild；测试走 vite 模块图），
 *              强行统一反而会有一边解析不到。
 *
 * @see vitest.config.mts；test/config/coverage-threshold.unit.test.ts；docs/自主决策记录.md AJ-46
 */

/** 参与统计的源码范围。测试文件不算（它们自己不需要被自己覆盖）。 */
export const COVERAGE_INCLUDE: string[] = ['packages/shared/src/**/*.ts', 'server/src/**/*.ts'];

export const COVERAGE_EXCLUDE: string[] = ['**/*.test.ts'];

/**
 * 覆盖率阈值。键是**文件路径**（相对仓库根），值是四个维度；
 * 另有一组全局键（lines/functions/branches/statements）作为兜底底线。
 *
 * ⚠️ **路径必须跟着文件走**：文件搬目录后如果这里不改，该条阈值会**静默失效**
 * （vitest 对匹配不到文件的阈值既不报错也不生效，全局底线还在，于是 gate 照绿）。
 * 2026-09-24 就真实发生过一次（auth.ts→app/、webhooks.ts→adapters/）。
 * 防复发靠 `test/config/coverage-threshold.unit.test.ts`。
 */
export const COVERAGE_THRESHOLDS: Record<string, number | Record<string, number>> = {
  lines: 85,
  functions: 85,
  branches: 85,
  statements: 85,

  // 《测试策略与验证门禁》§4.2 要求关键模块分支 100%，这里把它变成门禁而不是口头要求。
  // 审查指出：money.ts 分支只有 75% 也能过 gate——就是因为门槛只设了全局值。
  'packages/shared/src/money.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'packages/shared/src/orderNo.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },

  // 日志与上下文：脱敏是"漏一行就出事故"的能力，且缺陷形态是"重复键覆盖"（见 logger.ts @limitation 四），
  // 靠肉眼 review 看不出来。用 100% 闸门把它钉住——新增分支必须补测试，不能靠全局均值蒙混。
  'server/src/logger.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/context.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },

  // N16：脱敏 / 幂等 / 回调台账同属"错一处就是资金或合规事故"的模块，提到同一强度。
  // 真防御分支（竞态窗口、类型守卫的唯一调用方已保证）允许 `v8 ignore` + 中文理由注释，
  // 但不允许为凑覆盖率写假测试或删防御代码（见 docs/自主决策记录.md AJ-37）。
  'server/src/redact.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/adapters/idempotency.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/adapters/webhooks.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },

  // 时钟与单号：两者都是"口径级"代码——错了不会报错，只会让全站单号的日期段悄悄错一天。
  // 100% 的理由不是它们复杂（都只有几行），而是**它们的边界只能靠注入才测得到**，
  // 而"注入是否真的被用上"这件事如果没有阈值压着，改回 `new Date()` 也照样能提交。
  'server/src/adapters/clock.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/adapters/ids.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/domain/order-no.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },

  // F11 支付链路：端口、注册表、两个 Provider 实现、出站 HTTP——**全部 100%**。
  // @why 这一组是"钱"经过的路径，且它们的失败形态多为"不报错"：
  //      通道少出现一个（转化率静默下降）、下线通道还能建单（资金走错路）、
  //      金额少算 100 倍（零小数币种）、验签容差失效（重放）。
  //      更重要的理由是**新人加第三个 Provider 时要有同等的尺**：这些阈值就是那把尺。
  'server/src/ports/payment.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/adapters/payment/registry.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/adapters/payment/mock.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/adapters/payment/stripe-checkout.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  // 出站 HTTP：只有 20 行，但"没超时"这一条在生产上是挂死，必须锁住
  'server/src/adapters/http/fetch-client.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },

  // F11 第三单元（统一回调分发）：这四条同样 100%，理由比上面那一组更直白——
  // **它们是所有通道唯一的钱入口**。以前每个通道一条路由，写错只影响那一个通道；
  // 合并之后，`channels.ts` 少注册一个通道、`pay-routes.ts` 忘了登记 rawBodyPaths、
  // `pay-callback.ts` 把 40902 判成 40400，都是**全线**事故且不一定报错。
  // 100% 不是追求数字，是逼"加第三个 Provider 的人"必须同时补分支用例。
  'server/src/adapters/payment/channels.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/app/pay-routes.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/app/pay-callback.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/app/mark-paid.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },

  // F12 重试判定：**唯一一种"加了会让事情更糟"的容错**——不重试最多是失败，
  // 而错的重试会制造出本来不存在的第二次扣款，且上下游都认为自己是第一次。
  // 这一组纯函数就是那条红线的全部实现，必须 100%，且每个分类都要有对应用例。
  'server/src/ports/http-client.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },

  // F13 调度器契约：互斥与心跳是**看门狗的唯一依据**。它出错的形态不是报错，
  // 而是"某个 job 已经连续失败一天了，监控却显示刚刚还成功过"——
  // 那是比宕机更贵的一类失效（没人去看，也就没人发现）。归一化/汇总这两个纯函数是它的全部实现。
  'server/src/ports/scheduler.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  // 适配器侧是"互斥"与"心跳"的唯一实现：锁 ID 跨进程一致（否则多实例各锁各的）、
  // 失败不动 last_success_at（否则看门狗失明）——两条都是**错了也不报错**的形态，
  // 只能靠真库用例 + 100% 闸门压住。
  'server/src/adapters/scheduler.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  // 编排层：三条"错了也不报错"的性质全在这里——没抢到锁就什么都不做、
  // 一个子任务失败不影响其它子任务、**失败 job 的 emit 不分发**（幽灵副作用）。
  // 它们是所有定时任务共有的，靠 job 作者各自实现一遍等于交给概率。
  'server/src/app/scheduler.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },

  // 鉴权分支多（伪造 token 的每个维度都是独立分支），个别分支只能随管理端功能上线补齐；
  // 先钉 branch≥95%（当前 92.15 就是靠这条发现缺口），其余维度仍受全局 85% 约束。
  'server/src/app/auth.ts': { branches: 95 },
};
