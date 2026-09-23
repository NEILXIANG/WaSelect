// F0 工程底座：统一静态检查。红线：any / 未使用变量必须报红（见 docs/地基搭建清单 F0 验证项）。
// @see CLAUDE.md 约束二（小步）与约束六（注释）。
// @tradeoff 未引入 eslint-plugin-jsdoc：本机实测「jsdoc + typescript-eslint」同进程 import 会被
//   资源看门狗 SIGKILL（二分定位确认），而 jsdoc 规则只是 warn 级便利项，不是红线；
//   注释纪律改由「单元完成标准（CLAUDE.md）+ review」兜底。后续资源放宽后可再加回。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
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
    files: ['**/*.ts'],
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
    files: ['**/*.ts'],
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
      },
    },
  },
);
