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
        test: { name: 'db', include: ['**/*.db.test.ts'] },
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
      },
    },
  },
});
