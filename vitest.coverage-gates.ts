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

/**
 * 参与统计的源码范围。测试文件不算（它们自己不需要被自己覆盖）。
 *
 * ⚠️ 小程序侧的 `.js` **只收 `utils/` 下的**（2026-09-24 收口，此前一条 `.js` 都不收）。
 *    三条口径，各自都有实测理由，不是随手划的线：
 *    ① **收 `miniprogram/utils/*.js`**：这些是被单测**直接 import** 的（走 vite），
 *       覆盖率计数可靠，且当前实测都在 97%~100%（request 97 / 其余五个 100）。
 *    ② **不收 components 目录下的组件 js**：组件 js 是 `miniprogram-simulate`
 *       用 **Node 的 `require`** 加载的，v8 覆盖率对这条路径**计数不可靠**——
 *       实测：`ws-price` 组件的 `index.js` 里 `this.update()` 记到被调用 11 次，
 *       而同一个函数体的 `setData` 记 0（代码是对的，文案正确渲染，是计数错了）。
 *       收进来会给出**假信号**，那比不收更贵（会有人去追一个不存在的洞）。
 *       组件的行为已经由各自的组件级用例钉住（不写条数——条数一定会漂移成失真注释），不靠覆盖率数字。
 *    ③ **不收 `app.js` 与 `pages/**`**：它们是 `App()` / `Page()` 装配层，
 *       本身不可单测（要跑就得先有小程序运行时），收进来是两个 0% 的大文件，
 *       只会把全局均值拉低而换不来任何信号。它们的性质靠 L4 真机验收。
 *    ⚠️ 于是**新写的组件 js 不会自动进统计**——这是上面第 ② 条的代价，已知且接受。
 *    ④ **收各页面目录下的 `index.vm.js`**（glob 见下方数组；一致性审计 C6，AJ-176）：第 ③ 条写于约束十一之前。
 *       （⚠️ 注释里不写 glob 原文：星号紧跟斜杠会提前结束块注释，§2 第 7 条同一个坑。）
 *       约束十一把页面逻辑全部挪进 `*.vm.js` 纯函数，它们与 utils 一样被单测**直接 import**（走 vite），
 *       计数可靠；不收的后果是 9 个 vm（约 750 行、页面的全部逻辑）不在任何覆盖率门槛下，
 *       与《测试策略》§4.2「miniprogram 抽出的纯逻辑 行 ≥ 80%」直接矛盾。`index.js` 薄壳仍按第 ③ 条不收。
 */
export const COVERAGE_INCLUDE: string[] = [
  'packages/shared/src/**/*.ts',
  'server/src/**/*.ts',
  'miniprogram/**/*.ts',
  'miniprogram/utils/*.js',
  'miniprogram/pages/**/*.vm.js',
  // admin-web：只收 `.ts`（api 封装等纯逻辑）；`.tsx` 组件层**不收**——
  // ⚠️ 2026-10-01 订正（ADM3-07）：旧注释写"没有组件测试 harness（未引入 testing-library）"，
  //    已不是事实：`admin-web/src/testing/dom.ts` 起可以跑 jsdom 组件用例（`*.dom.unit.test.ts`）。
  //    不收的**真实**理由是：组件用例的断言依赖 DOM 结构（改个 class 或嵌套就可能整片失配），
  //    把它算进覆盖率会让"阈值"被 UI 改动牵着走，且组件行为本就由各自的组件用例钉住，
  //    覆盖率数字换不来额外信号。UI 的性质靠构建（vite build 进 gate）+ L4 人工验收。
  'admin-web/src/**/*.ts',
];

export const COVERAGE_EXCLUDE: string[] = [
  '**/*.test.ts',
  '**/*.test.tsx',
  // 夹具是"故意违规"的样本，它不是被测代码（@see miniprogram/utils/wx-global.fixture.js）
  '**/*.fixture.js',
];

/**
 * 覆盖率阈值。键是**文件路径**（相对仓库根），值是四个维度；
 * 另有一组全局键（lines/functions/branches/statements）作为兜底底线，
 * 再加 `scripts/check-coverage-floor.mjs` 的逐文件底线（行 60 / 分支 50）。
 *
 * ⚠️ **路径必须跟着文件走**：文件搬目录后如果这里不改，该条阈值会**静默失效**
 * （vitest 对匹配不到文件的阈值既不报错也不生效）。防复发靠 `test/config/coverage-threshold.unit.test.ts`。
 *
 * @why **按风险分级**（2026-10-05 用户批准的测试瘦身，AJ-365）：逐文件 100% 只留给
 *      「钱 / 订单状态 / 幂等与回调登记 / 鉴权 / 脱敏」——这些模块错了不报错、却会直接造成资金或安全事故。
 *      此前名单有 44 个文件，基础设施类（日志、时钟、存储、调度、熔断、出站 HTTP、小程序宿主封装、
 *      管理端请求封装等）也钉在 100%，每加一个分支就得补测试，测试规模因此涨到源码的 1.5 倍。
 *      这些文件**现有测试一条没删**，只是不再强制 100%，改由全局 85% 与逐文件底线约束。
 *      被移出名单的文件与当时的理由见 git 历史（本文件 2026-10-05 之前的版本）。
 * @limitation 未达 100% 的几条（admin-auth / admin-auth-routes / block-user / mark-disputed）
 *      是竞态窗口或不变式违反的兜底分支，数字是**下限**，原因见 docs/自主决策记录.md AJ-324。
 */
export const COVERAGE_THRESHOLDS: Record<string, number | Record<string, number>> = {
  lines: 85,
  functions: 85,
  branches: 85,
  statements: 85,

  // ── 钱：金额换算、单号、支付端口与通道、回调入口、落账、退款、拒付 ──
  'packages/shared/src/money.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'packages/shared/src/orderNo.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/domain/order-no.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
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
  'server/src/adapters/payment/channels.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/app/pay-routes.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/app/pay-callback.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/app/mark-paid.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'server/src/app/refund-execution.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/app/mark-disputed.ts': { lines: 94, functions: 100, branches: 89, statements: 94 },
  'miniprogram/utils/price-format.js': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },

  // ── 订单状态与准入：状态机迁移表、退款 / 发货 / 改址闸门、"提交后才分发" ──
  'server/src/domain/order.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  // AJ-383：部分退款准入与整单退款余额——"最多退多少"的唯一判定处，错一个边界就是多退
  'server/src/domain/partial-refund.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/domain/admin-order-actions.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/app/unit-of-work.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },

  // ── 幂等与回调登记：重复扣款、重复落账的最后一道闸 ──
  'server/src/adapters/idempotency.ts': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  'server/src/adapters/webhooks.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'miniprogram/utils/idempotency.js': {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },

  // ── 鉴权与风控 ──
  'server/src/app/auth.ts': { branches: 95 },
  'server/src/adapters/admin-auth.ts': { lines: 96, functions: 100, branches: 94, statements: 99 },
  'server/src/app/admin-auth-routes.ts': {
    lines: 94,
    functions: 100,
    branches: 86,
    statements: 94,
  },
  'server/src/app/block-user.ts': { lines: 99, functions: 100, branches: 89, statements: 94 },

  // ── 脱敏：漏一行就是个人信息进日志 ──
  'server/src/redact.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
};
