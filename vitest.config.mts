/**
 * 职责：测试框架配置（F1）——五个分层 project（unit / db / contract / e2e + lint 元层，AJ-03）+ v8 覆盖率阈值。
 * 分层约定：*.unit.test.ts = L0 纯函数；*.db.test.ts = L1 真库集成；*.contract.test.ts = L2 契约；test/e2e/** = L3 端到端。
 * @see docs/测试策略与验证门禁.md §3/§4、docs/地基搭建清单.md F1
 * @tradeoff（历史，F1 阶段）db/contract/e2e 当时尚无测试文件，passWithNoTests 曾放空通过——
 *          现已关闭（见下方 `passWithNoTests: false` 的注释），且各层均已有测试文件接入
 *          （F7 真库、F11 Provider 契约、F6c 起 e2e）。
 * @limitation 覆盖率阈值是**逐文件**的（唯一真源在 `vitest.coverage-gates.ts`）：新文件只要落进
 *             include，下一次 `check:coverage-floor` 就按"行 60% / 分支 50%"的底线要求它——
 *             不是"先豁免、以后再说"，加文件时**不需要**也**不应该**回来改这份配置。
 *             ⚠️ 这里曾经写"server/src 为空目录时不参与统计"（DB-14）——那是 F1 阶段的实况
 *             （当时服务端还是空壳），现在 server/src 早已不是空目录，留着会让人以为
 *             "服务端代码不在阈值覆盖内"，从而对新文件是否达标产生错误预期。
 */
import { defineConfig } from 'vitest/config';
// 阈值表单独成文件（唯一事实来源）：它还要被 test/config/coverage-threshold.unit.test.ts 读去验证
// "每条阈值都还命中真实文件"。用 `.ts` 而不是 `.js` 是因为本文件由 esbuild 直接解析，
// 不做 NodeNext 的 `.js → .ts` 映射。@see vitest.coverage-gates.ts 文件头
import {
  COVERAGE_EXCLUDE,
  COVERAGE_INCLUDE,
  COVERAGE_THRESHOLDS,
} from './vitest.coverage-gates.ts';

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
    /**
     * 把 worker 数 cap 到 4（默认 = CPU 核数）。
     * @why 本机是 12 核，vitest 默认开 12 个 worker 并行 + v8 coverage 的内存开销，
     *      全量 `npm run cov`（4 个 project 一起跑）峰值内存/CPU 过高，会触发宿主（IDE/沙盒）的
     *      资源看门狗，进程被 SIGKILL(137)——表现为"偶发、无输出、连日志都写不全"。
     *      cap 到 4 后峰值骤降，全量 cov 可稳定跑完。
     * @measured 2026-10-14：默认 12 worker 跑全量 cov 偶发 SIGKILL(137)；
     *            `--maxWorkers=4` 跑全量 cov → exit 0、10m25s 稳定完成、负载峰值从 ~11 降到 ~7。
     * @limitation vitest 默认 worker 数是 CPU 数减 1（四天提交复查 2026-10-16 订正：原注释写"CI 默认 4、cap 是 no-op"不对）——
     *            CI（ubuntu-latest，4 核）从 3 升到 4，本地 12 核从 11 降到 4；两边都跑同一条命令，只是并发数不同。
     */
    maxWorkers: 4,
    // `.claude/worktrees/`：并行分身的工作树（整仓副本），不排除会把另一份代码的测试一并跑进来
    // `.stryker-tmp/`：变异测试的沙盒副本（含全部测试文件），不排除会把同一批测试再跑一遍
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', '.stryker-tmp/**'],
    /**
     * 外网闸门（F12）：**每个测试文件**运行前都装上——未放行的出站请求直接抛错。
     * @why 放在 setupFiles 而不是让每个测试自己记得调用：靠"记得"的闸门等于没有闸门。
     *      它放行本机（localhost/127.0.0.1），所以端到端测试真起端口不受影响。
     * @limitation 只拦 `fetch`；且 `vi.stubGlobal('fetch', …)` 会整体替换它——
     *      那些用例本来就用假 fetch，闸门的实际覆盖是"忘了 stub 的用例"。
     * @see test/setup/network-guard.ts
     */
    setupFiles: ['./test/setup/install-network-guard.ts'],
    projects: [
      {
        // `.tsx`：管理端用 JSX 写的组件测试（第三轮审查 TST3-07；不收的话它会静默不跑）
        test: { name: 'unit', include: ['**/*.unit.test.ts', '**/*.unit.test.tsx'] },
      },
      {
        // db 层必须**串行**：所有 db 用例共用一个测试库，且用例之间靠 TRUNCATE 重置；
        // 并行时两个文件会互删对方刚写入的数据（实测：提交后数据可见 / 幂等并发两条同时变红），
        // 这类红灯是环境导致的假失败，最难排查。串行换来确定性，代价是 db 层慢一点（当前 3s 内）。
        //
        // ⚠️ `hookTimeout` / `testTimeout` 放宽到 30s 是**实测**逼出来的，不是保守：
        //      2026-09-27 的 `cov` 一轮（unit/contract/e2e 与 db 并发跑，共用同一个 Postgres）
        //      在本机负载 ~13 时，`beforeAll` 里的 `ensureTestDb()`（子进程跑 node-pg-migrate）
        //      与 `beforeEach` 里的 `resetTestDb()`（TRUNCATE 全部业务表）双双超过 vitest 默认的 10s，
        //      表现为 Hook timed out ——而同一批复测用例单跑 db 层是 476/476 绿、137s。
        //      即：**红灯来自资源争用，不来自被测逻辑**。
        //      与 lint 层放宽 `testTimeout` 是同一类理由（那里是每个文件各建一个 TS Program）。
        //
        // ⚠️ 注意区分两件不同的事（2026-09-30 补记，@see AJ-216）：
        //    - **本层内部**的互删 → 由本层的 `fileParallelism: false` 解决（上面第一段）；
        //    - **跨 project**（db 与 e2e 在 `cov` 一轮里并发）的互删 → 由**分库**解决
        //      （e2e 用 `japan_shop_e2e_test`，见本文件 e2e project 的 `env`）。
        //      2026-09-27 那次把超时放宽到 30s 只缓解了"资源争用"，**没有**解决互删——
        //      数据被别人删掉时用例跑得很快（只是断言读到 0 / 40101），再宽的超时也拦不住。
        //      别再把"并发那一轮的随机红灯"归因到机器慢：先问串行还是并发，再问忙不忙。
        // @limitation 放宽超时**不承担**正确性判断：真死锁/真挂起仍会超过 30s 而失败，
        //              它只是把"机器忙"这一档噪声从结果里挪出去。
        //              🚫 因此不要把某条用例"偶发超时"直接归因到机器慢就了事——
        //              先单跑该层确认绿，再判断是不是争用（否则这里会变成掩盖真缺陷的抽屉）。
        test: {
          name: 'db',
          include: ['**/*.db.test.ts'],
          fileParallelism: false,
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
      {
        test: { name: 'contract', include: ['**/*.contract.test.ts'] },
      },
      {
        // e2e 层同样必须**串行**，理由比 db 层更隐蔽：两个文件各起一个服务，各自 `resetTestDb()` 会
        // 把对方的库清空；表现出来是"单跑这个文件绿、跑全套就随机红"，极难复现。
        // @limitation 串行的代价是 e2e 变慢；当前 7 个文件（20s 内），可接受。
        //
        // ⚠️ `env.TEST_DB_PROJECT` 是**并发隔离**，与上面的串行是两件事、缺一不可：
        //    串行只让 e2e **内部**不打架；`cov` 一轮里 e2e 与 db 是**两个 project 并发**跑的，
        //    它们各起各的服务、各自 TRUNCATE，共库时 db 的用例会被 e2e 的 reset 打掉
        //    （2026-09-30 实测：`admin-ops-routes.db.test.ts` 两条同时红，
        //     `count(*) from fx_rates` 读回 0、刚 seed 的管理员拿到 40101）。
        //    分库后两边用的是两个物理库，谁也不会删谁的数据。
        //    @see test/db/test-db.ts 的 `testDbNameFor`（库名的唯一生产者）
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          fileParallelism: false,
          env: { TEST_DB_PROJECT: 'e2e' },
        },
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
      include: COVERAGE_INCLUDE,
      exclude: COVERAGE_EXCLUDE,
      // 阈值表与它的全部理由都在 vitest.coverage-gates.ts（唯一事实来源）。
      // ⚠️ 里面的**路径必须跟着文件走**（R2-1 教训）：2026-09-24 发现 auth.ts / webhooks.ts
      //    分别搬进 app/ 与 adapters/ 之后，那两条阈值**静默失效**——
      //    vitest 对"匹配不到任何文件的阈值"既不报错也不生效，全局 85% 还在，
      //    于是"webhooks 必须 100%"这条最硬的约束悄悄消失了，而 gate 一直是绿的。
      //    这类失效比阈值写错更危险：它表现为"我明明设了门禁"，实际门是开着的。
      //    防复发靠 test/config/coverage-threshold.unit.test.ts（断言每个键至少命中一个真文件）。
      thresholds: COVERAGE_THRESHOLDS,
    },
  },
});
