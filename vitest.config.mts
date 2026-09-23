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
    /**
     * ⚠️ 关掉 `passWithNoTests`（T4）。
     * @why 打开它的理由曾经成立（F1 阶段四层都还没有测试文件），现在不成立：
     *      留着的后果是"include 模式写错 / 目录改名 / 文件名拼错 → 一个测试都没匹配上"
     *      也照样绿灯——这是最危险的一类假绿灯，因为它看起来和真绿灯一模一样。
     * @limitation `npm run test:fast`（带 `--changed`）在没有改动测试文件时会因此失败，
     *              所以那个脚本单独加了 `--passWithNoTests`：它本来就是"没改动就什么都不跑"的
     *              便利命令，不是门禁。门禁用 `npm run gate`，不含 --changed。
     */
    passWithNoTests: false,
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
        // e2e 层同样必须**串行**，理由比 db 层更隐蔽：两个文件各起一个服务，各自 `resetTestDb()` 会
        // 把对方的库清空；表现出来是"单跑这个文件绿、跑全套就随机红"，极难复现。
        // @limitation 串行的代价是 e2e 变慢；当前只有一个文件（~1s），可接受。文件多了再考虑分库。
        test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], fileParallelism: false },
      },
      {
        /**
         * lint 层：跑 ESLint 的 Node API，断言"类型感知规则真的在起作用"（A5 的门禁的门禁）。
         * @why 必须**独立成 project**而不是塞进 unit：跑一次要建 TS Program（~15s），
         *      放进 unit 会把 2s 的快反馈环拖到 17s，代价远大于收益。
         *      独立之后它只在 `npm run test:lint` / `npm run gate` 里跑——那正是"慢但必须跑"的地方。
         * @limitation 文件名必须是 `*.lint.test.ts` 而不是 `*.unit.test.ts`：
         *      否则会被 unit 的 include 模式（通配的 `.unit.test.ts`）一并收走，白白多付一次 15s。
         *      ⚠️ 注释里不要原样抄那个通配模式——它含「星号+斜杠」这两个连续字符，
         *         会把这段块注释提前结束（我就这么把配置文件写坏过两次）。
         *
         * ⚠️ `fileParallelism: false` 是实测出来的，不是保守：
         *      本层每个文件都要各自建一个 TS Program（ESLint 类型感知）或全量扫描源码，
         *      并行时两个进程抢 CPU，单文件耗时从 1.8s 涨到 **超过默认 5s 超时**——
         *      表现为"单跑这个文件绿、跑全层随机超时"。这类红灯是环境导致的假失败，最难排查，
         *      所以串行；`testTimeout` 再放宽到 30s，覆盖慢机器上的抖动。
         */
        test: {
          name: 'lint',
          include: ['**/*.lint.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
        },
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
