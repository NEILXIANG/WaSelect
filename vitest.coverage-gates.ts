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
  'server/src/idempotency.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/adapters/webhooks.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },

  // 鉴权分支多（伪造 token 的每个维度都是独立分支），个别分支只能随管理端功能上线补齐；
  // 先钉 branch≥95%（当前 92.15 就是靠这条发现缺口），其余维度仍受全局 85% 约束。
  'server/src/app/auth.ts': { branches: 95 },
};
