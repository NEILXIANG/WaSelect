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
      'dist/**',
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
