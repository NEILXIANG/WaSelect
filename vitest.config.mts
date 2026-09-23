/**
 * 职责：测试框架配置（F1）——四个分层 project + v8 覆盖率阈值。
 * 分层约定：*.unit.test.ts = L0 纯函数；*.db.test.ts = L1 真库集成；*.contract.test.ts = L2 契约；test/e2e/** = L3 端到端。
 * @see docs/测试策略与验证门禁.md §3/§4、docs/地基搭建清单.md F1
 * @tradeoff db/contract/e2e 在 F1 阶段尚无测试文件，passWithNoTests 放空通过——
 *          它们的真实接入分别在 F7（真库）、F11（Provider 契约）、I1 业务期；
 *          风险：gate 在这些层"形同虚设"直到接入，已在清单标注，不是漏配。
 * @limitation 覆盖率阈值当前只覆盖已有文件（packages/shared），server/src 为空目录时不参与统计；
 *             后续每加一个模块，阈值约束自动生效（include 已含 server/src/**）。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    projects: [
      {
        test: { name: 'unit', include: ['**/*.unit.test.ts'] },
      },
      {
        // db 层必须**串行**：所有 db 用例共用一个测试库，且用例之间靠 TRUNCATE 重置；
        // 并行时两个文件会互删对方刚写入的数据（实测：提交后数据可见 / 幂等并发两条同时变红），
        // 这类红灯是环境导致的假失败，最难排查。串行换来确定性，代价是 db 层慢一点（当前 3s 内）。
        test: { name: 'db', include: ['**/*.db.test.ts'], fileParallelism: false },
      },
      {
        test: { name: 'contract', include: ['**/*.contract.test.ts'] },
      },
      {
        test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'] },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/shared/src/**/*.ts', 'server/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: {
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
      },
    },
  },
});
