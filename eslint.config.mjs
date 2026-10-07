// F0 工程底座：统一静态检查。红线：any / 未使用变量必须报红（见 docs/地基搭建清单 F0 验证项）。
// @see CLAUDE.md 约束二（小步）与约束六（注释）。
// @tradeoff 未引入 eslint-plugin-jsdoc：本机实测「jsdoc + typescript-eslint」同进程 import 会被
//   资源看门狗 SIGKILL（二分定位确认），而 jsdoc 规则只是 warn 级便利项，不是红线；
//   注释纪律改由「单元完成标准（CLAUDE.md）+ review」兜底。后续资源放宽后可再加回。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// ─────────────────────────────────────────────────────────────────────────────
// F10 分层规则的**定义**放在文件顶部（`export default` 之前）：
// 下面的 `tseslint.config(...)` 调用是**立即求值**的，
// 若把这些 const 写在它后面，会撞 TDZ（ReferenceError: Cannot access before initialization）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 分层规则同时作用在两处：**真实代码树**与**夹具树**。
 * @why 两处共用同一份定义（下面的 layeringBlocks 生成器），否则"夹具绿、真代码不生效"
 *      是极难发现的一类假绿——规则改了只改一边，另一边静默失效。
 */
const LAYER_ROOTS = ['server/src', 'test/lint/layering'];

/**
 * "时间 / 随机源"纯度规则的作用范围（与分层规则同一套路：真代码树 + 夹具树）。
 * 夹具子目录用 `purity` 而不是复用 `layering`——两套规则的**豁免清单不同**，
 * 混在一棵树里会出现"这个文件为了测 A 规则写的违规，被 B 规则也报了"的互相干扰。
 */
const PURITY_ROOTS = ['server/src', 'test/lint/purity'];

/**
 * 业务侧禁止出现的**全局状态读取**（F10 最后一项的静态门禁）。
 *
 * @why 光有 `Clock` / `IdGen` 两个端口**拦不住任何人**：把它们接好之后的第二天，
 *      有人在 order 路由里写了一句 `new Date()`，一切照常工作、照常上线，
 *      直到"日本时间早上 9 点前下的单，单号日期是昨天"被发现为止。
 *      端口提供的是"可以用"，这条规则提供的是"不可以用别的"。
 * @why 用 `no-restricted-syntax`（**AST 选择器**）而不是文本扫描：
 *      文本扫描会被注释骗过——本仓库里 `new Date()` 大量出现在注释中
 *      （"禁止在这里 new Date()"），文本扫描要么永久红、要么得先手写一套去注释逻辑。
 *      AST 只看代码节点，天然免疫。
 *
 * @limitation 一：以下是**显式豁免**，每一条都必须有理由，新增豁免等于新增风险：
 *        - `adapters/**`：边界层，系统时间 / 随机数就该住在这里（它们本就是"进程外的东西"）；
 *        - `logger.ts`：pino 时间戳必须是真实挂钟——排障时"日志时间"不能是假的；
 *        - `context.ts`：`trace_id` 用 `randomUUID()`，它与业务判定无关，
 *          且链路 ID 本来就要跨进程唯一（注入进去反而让"谁生成它"变成一个问题）；
 *        - `app/auth.ts`：JWT 的 `iat/exp` 用 `Date.now()`——token 有效期对照的是
 *          **真实时间**（验签方读的是真实时钟），注入时钟会让"过期"这件事在测试里失真；
 *        - `*.test.ts`：测试正是要用固定/随机时间去覆盖边界，禁止它就写不了测试。
 * @limitation 二：只禁这五种写法，不禁 `Date.parse` / `Date` 作为参数类型等形态——
 *              精确打击比全面封杀更容易长期存活（全面封杀的第一反应是有人把整块关掉）。
 */
const PURITY_SELECTORS = [
  {
    selector: 'NewExpression[callee.name="Date"]',
    message:
      'F10：业务侧不得 new Date()——时间经 ports/clock.ts 的 Clock 注入，' +
      '否则 JST 业务日、跨日边界、到期判断都只能在真实时间下测。',
  },
  {
    selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]',
    message: 'F10：业务侧不得读 Date.now()——同上，走 Clock 端口（app/auth.ts 的 JWT 除外）。',
  },
  {
    selector: 'CallExpression[callee.name="randomUUID"]',
    message: 'F10：业务侧不得自己摇 UUID——走 ports/ids.ts 的 IdGen.uuid()。',
  },
  {
    selector: 'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
    message: 'F10：业务侧不得用 Math.random——走 IdGen 端口（随机段口径只有一个来源）。',
  },
  {
    selector: 'CallExpression[callee.name="randomOrderSeq"]',
    message: 'F10：业务侧不得直接调 randomOrderSeq——走 IdGen.orderSeq()。',
  },
];

/** 各层禁止的依赖（同一份定义，供两棵树复用）。 */
const FORBIDDEN = {
  domain: {
    patterns: [
      {
        group: ['**/adapters/**'],
        message:
          'F10 分层：domain 不得依赖 adapters（方向 app → domain → ports ← adapters）。' +
          '要用这个能力，请在 ports/ 声明接口，由 app/ 注入实现。',
      },
      {
        group: ['**/app/**'],
        message: 'F10 分层：domain 不得依赖 app（app 是组装层，只有它依赖别人）。',
      },
    ],
    paths: [
      { name: 'express', message: 'F10 分层：domain 不得依赖 Web 框架（Express 属于 app/）。' },
      {
        name: 'postgres',
        message: 'F10 分层：domain 不得依赖数据库驱动（持久化经 ports/ 注入）。',
      },
      {
        name: 'stripe',
        message: 'F10 分层：domain 不得依赖具体支付机构 SDK（走 PaymentProvider 端口）。',
      },
    ],
  },
  ports: {
    patterns: [
      {
        group: ['**/adapters/**', '**/domain/**', '**/app/**'],
        message:
          'F10 分层：ports 只声明接口，不得依赖实现（adapters）或上层（domain/app）——' +
          '否则与 domain→ports 成环，换实现就得先解开一坨互相 import。',
      },
    ],
  },
  adapters: {
    patterns: [
      {
        group: ['**/app/**'],
        message:
          'F10 分层：adapters 不得反向依赖 app（组装层单向）。' +
          '适配器不该知道谁在用它，否则"注册即接入"就没了。',
      },
    ],
  },
};

/** 生成某一棵树的三个 block（domain / ports / adapters）。 */
function layeringBlocks(root) {
  return ['domain', 'ports', 'adapters'].map((layer) => ({
    files: [`${root}/${layer}/**/*.ts`],
    rules: { 'no-restricted-imports': ['error', FORBIDDEN[layer]] },
  }));
}

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      'node_modules/**',
      '**/node_modules/**',
      // ⚠️ 必须写 `**/dist/**`：`dist/**` 只匹配**根级**的 dist，
      //    A1 之后构建产物落在 server/dist 与 packages/shared/dist，
      //    只写前者会让 ESLint 去 lint 编译后的 JS（报一堆 process/Buffer is not defined）。
      '**/dist/**',
      'coverage/**',
      '**/*.config.js',
      '**/*.config.mjs',
      'miniprogram/miniprogram_npm/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Node 运行时全局：flat config 默认不给 no-undef 声明控制台与 process，脚本文件会被误报
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    /**
     * 类型感知规则（A5）——三条，只多不少。
     * @see docs/基座评审报告与解决方案-2026-09-23.md A5
     *
     * @why 这三条恰好打在本项目最容易出事的三类代码上：
     *   1. `no-floating-promises`：忘记 await 的 Promise**不会报错**——
     *      写支付回调、写调度器时，"我以为它执行了"是最常见也最难查的事故形态；
     *   2. `no-misused-promises`：把 Promise 传给要求同步返回值的位置
     *      （典型：`if (asyncFn())` 恒真、`arr.forEach(async …)` 静默丢错误）；
     *   3. `switch-exhaustiveness-check`：订单状态机新增一个状态时，
     *      所有 switch 必须显式处理，否则"新状态走到默认分支"要等到线上才暴露。
     *
     * @tradeoff 只开这三条，而不是整套 `recommendedTypeChecked`：
     *   整套里有 `no-unsafe-assignment` / `no-unnecessary-condition` 这类
     *   需要大面积改写的规则，一次性引入会把"真正要防的三条"淹没在几百条噪音里，
     *   结果往往是有人把整个 block 关掉——那就一条都没了。宁可少开、开得住。
     * @limitation 类型感知 lint 需要建 TS Program，比普通 lint 慢（当前全仓 ~20s 级）。
     *             若将来慢到影响提交体验，优先考虑给 `files` 收窄范围，而不是关规则。
     *
     * ⚠️ `checksVoidReturn` 五项全开（默认值，**不要**为了 Express 去关 arguments）——
     *    这是实测出来的，不是想当然：
     *      · 担心 `app.get('/x', async (req,res) => …)` 会被误报，所以先试了
     *        `checksVoidReturn.arguments: false`；
     *      · 实测发现**关了才会漏**：@types/express 5 的 `RequestHandler` 返回类型是
     *        `void | Promise<void>`，async handler 在 `arguments: true` 下**本来就不报**（探针第 38 行无错）；
     *      · 而 `arguments: false` 会放过 `[1,2,3].forEach(async n => …)`（探针第 45 行）——
     *        那正是"错误被静默吞掉、且根本不串行等待"的经典形态，比 Express 那条重要得多。
     *    结论：默认全开，两头都对。若将来降级到 Express 4，async handler 会开始报红，
     *    那时该改的是升级 Express，不是关这条规则。
     */
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        // `projectService` 让每个文件自动归属到 tsconfig，省掉手工维护 `project` 映射；
        // tsconfig.json 的 include 已覆盖全仓 .ts（packages/server/test/miniprogram），无孤儿文件。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // 不传选项 = `checksVoidReturn` 全开，理由见本 block 的 ⚠️ 注释（实测结论，别凭直觉改）。
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // 小程序端：宿主注入的全局（wx / App / Page / getApp）不在 Node 全局里，
    // flat config 默认不认，会被 no-undef 误报。这里按小程序运行时声明。
    files: ['miniprogram/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        wx: 'readonly',
        App: 'readonly',
        Page: 'readonly',
        Component: 'readonly',
        getApp: 'readonly',
        console: 'readonly',
        // `setTimeout` / `clearTimeout` 由**小程序运行时**提供（与浏览器同名同义），
        // 不是宿主 API `wx.*`——所以它不需要也不该登记进 `utils/wx-api.ts`。
        // @why 不逐个文件写 `/* global */`：那等于每用一个标准全局就发明一次绕法，
        //      而本块正是"小程序端全局白名单"的唯一落点。
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    /**
     * F14：小程序端**禁止直接引用宿主全局 `wx`**——一律走 `utils/wx-api.js` 的封装。
     *
     * @why 这条规则是上一块的**反向收紧**：上一块把 `wx` 声明为合法全局（否则 no-undef 误报），
     *      但"合法"不等于"可以直接用"。业务代码里散落的 `wx.xxx` 会带来三个问题：
     *      ① 不可测（Node 侧引用就崩，于是每个模块各发明一套绕法——本仓库在封装之前已有三种）；
     *      ② 错误形态不可控（宿主缺失时崩在 `undefined.request`，报错指向业务行）；
     *      ③ 没有类型（`getStorageSync` 返回 unknown，调用方各写各的断言）。
     *      写了文档、写了 CLAUDE.md 都拦不住——只有会红的规则拦得住。
     *
     * @why 用核心规则 `no-restricted-globals` 而不是自己写 AST 选择器：
     *      它是官方规则、零依赖，且**不会误伤注释**（注释里提到 `wx.request` 是常事，
     *      自己写正则扫描会把注释里的 `wx.` 也报出来——那种假红会逼人去改注释措辞）。
     *
     * @limitation 一：只挡**全局引用**。局部变量叫 `wx` 不算（作用域分析会跳过），
     *              所以测试里 `const h = fakeWx()` 不受影响；但为了可读性仍建议别起这个名字。
     * @limitation 二：只挡 `wx` 这一个名字。`App` / `Page` / `Component` / `getApp` 同样
     *              是宿主全局，但它们只在**页面/组件/入口文件**里出现且无法收敛到一处
     *              （小程序框架要求它们就在那里），强行收口只会多一层无意义的转发。
     */
    files: ['miniprogram/**/*.{js,ts}'],
    ignores: ['miniprogram/utils/wx-api.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'wx',
          message:
            '不要直接使用宿主全局 wx —— 走 utils/wx-api.js 的 createWxApi()。' +
            '需要新的 wx 能力请先在 wx-api.js 登记一个方法（F14）。',
        },
      ],
    },
  },

  /**
   * F10 分层与依赖方向（R2-1）——把"架构约定"变成**会红的检查**。
   *
   * @why 约定写在架构文档里拦不住任何人：三个月后有人在 domain 里 `import Stripe`，
   *      一切都还能跑，直到要换支付通道时才发现业务核心已经和具体机构焊死了——
   *      那条 import 当天就该是红的。规则是唯一不会疲劳的 review。
   * @why 用**核心规则** `no-restricted-imports` 而不是 `import/no-restricted-paths`：
   *      后者要装 eslint-plugin-import，而本机实测多插件与 typescript-eslint 同进程
   *      会被资源看门狗 SIGKILL（此前 eslint-plugin-jsdoc 已踩过同一个坑）。
   *      核心规则零依赖、零该风险；代价是**按 import 字符串匹配**而非解析后的绝对路径，
   *      于是 `../adapters/x.js` 靠 glob 命中（已由夹具验证会报，见 test/lint/layering）。
   *
   * 允许的方向（@see docs/可扩展架构设计…md §4）：
   *   `app → domain → ports ← adapters`，且 `app` 可以依赖所有层（它是组装层）。
   * 被禁的四类：
   *   ① domain → adapters / app / 框架 / 驱动 / 三方 SDK（业务核心必须不认识具体技术）
   *   ② ports  → adapters / domain / app（接口层依赖实现会与 domain→ports 成环）
   *   ③ adapters → app（适配器不能知道"谁在用它"，否则删一个适配器要改 app）
   *
   * @limitation 一：**只管 import 方向，不管代码内容**。把适配器逻辑整个写进
   *             `domain/` 目录，这条规则一条都不会报——那是 review 的事。
   * @limitation 二：`domain → events` 目前**允许**。events/ 现在只打算放事件类型与发布接口；
   *             R2-2 落地"进程内总线（有状态运行时）"时，若总线不在 ports 后面，
   *             就要把这一条也加进 domain 的黑名单（届时连总线一起改成注入）。
   * @limitation 三：同一层内部（如 adapters 之间）**不设限**。跨适配器互相依赖
   *             （stripe → notify）目前没有真实需求，等出现时再加 zone，不提前设限。
   */
  ...LAYER_ROOTS.flatMap(layeringBlocks),

  /**
   * 纯度规则本身：默认覆盖 `server/src/**`（**fail-closed**，新目录自动受约束），
   * 只豁免上面 @limitation 一里逐条写明理由的几处。
   *
   * @why 用"默认全管 + 显式豁免"而不是"逐目录点名"：后者在新建业务目录时会静默漏掉——
   *      那条新目录里的 `new Date()` 不会被任何东西拦住，而 gate 依然是全绿的。
   */
  ...PURITY_ROOTS.map((root) => ({
    files: [`${root}/**/*.ts`],
    ignores: [
      'server/src/adapters/**',
      'server/src/**/*.test.ts',
      'server/src/logger.ts',
      'server/src/context.ts',
      'server/src/app/auth.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', ...PURITY_SELECTORS] },
  })),
);
