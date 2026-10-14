#!/usr/bin/env node
/**
 * 职责：在**干净确定的 Node 环境**里跑一条命令——剥掉 `NODE_OPTIONS` 里的 `--require=…` 注入，
 *      再 spawn 真正的命令，把退出码原样透传。
 *
 * @why 宿主（IDE / 沙盒）会往 `NODE_OPTIONS` 塞 `--require=<宿主 shim>`（例如 WorkBuddy 的
 *      `node-language-shim.cjs`）。那个 shim 在会话环境里 monkey-patch `fs`，使**文件密集**的
 *      操作（ESLint 类型感知要遍历整棵源码树建 TS Program）慢 3~6 倍：
 *      `test/lint/type-aware.lint.test.ts` 那条"三条规则都挂上了"用例从 5.9s 飙到 36s，
 *      超过 `vitest.config.mts` lint 层的 `testTimeout: 30_000`，报 `Test timed out in 30000ms`；
 *      全层一起跑时还会进一步撞本机资源看门狗，进程被 SIGKILL(137)、连日志都写不全。
 *      这类红灯是**宿主环境导致的假失败**，与代码正确性无关。
 * @measured 2026-10-14：带 shim（`NODE_OPTIONS=--require=node-language-shim.cjs`）跑
 *            `test:lint` → type-aware 用例 36s 超时、进程 exit 137；
 *            `env -u NODE_OPTIONS` 跑 → 14 文件 46 用例全绿、37s。
 *            关闭 shim 内部开关（`CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0` /
 *            `CODEBUDDY_SAFE_DELETE_ENABLED=0`）**无效**——慢的根源是 `--require` 本身
 *            （shim 在 `SESSION_ID` 存在时无条件 `require` 861 行的 safe-delete-shim）。
 * @why 剥 `--require` 而不是清空整个 `NODE_OPTIONS`：`NODE_OPTIONS` 里可能还有别的合法选项
 *      （如 `--max-old-space-size`、`--experimental-*`），清空会误伤。只剥 `--require` 片段，
 *      其余原样保留——门禁要的是"干净"，不是"空"。
 * @limitation 一：只处理 `--require=value` 与 `--require value` 两种写法；其它会把代码注入进程的
 *              `NODE_OPTIONS` 选项（`--import`、`--loader`）不在本脚本职责内——今天没有宿主用它们。
 * @limitation 二：`NODE_OPTIONS` 的 `--require` 在**当前进程启动时就已经生效**，本脚本剥掉的是
 *              **子进程**的注入；本脚本自身仍在带 shim 的进程里跑（但不做文件密集操作，无实际影响）。
 * @limitation 三：CI（GitHub Actions）里没有 `SESSION_ID`，shim 本就直接空转返回，剥掉是 no-op——
 *              本脚本对 CI 无副作用，纯粹是"本地在宿主里跑门禁"这一场景的守护。
 * @see package.json test:lint；vitest.config.mts lint 层的 `testTimeout: 30_000`；
 *      用户备忘「`eslint .` / 长输出命令报 write EPIPE：宿主注入的 node shim 所致」
 */
import { spawnSync } from 'node:child_process';
import { isMain } from './is-main.mjs';

/**
 * 剥掉 `NODE_OPTIONS` 里的 `--require` 注入，返回干净的字符串（空则返回 undefined）。
 * @param {string | undefined} nodeOptions 原始 `NODE_OPTIONS`
 * @returns {string | undefined}
 */
export function stripRequire(nodeOptions) {
  if (!nodeOptions) return undefined;
  // 先剥 `--require value`（value 不含空白、不以 `-` 开头），再剥 `--require=value`。
  // @why 用正则而不是 token 数组：两种写法在 token 切分后形态不同（`--require` 单独成 token），
  //      一次性正则最直观，也避免"删掉 --require 后残留一个悬空的 value"。
  let cleaned = nodeOptions.replace(/\s--require\s+\S+/g, ' ').replace(/\s?--require=\S+/g, ' ');
  // 开头也可能是 `--require …`（前面没有空白）
  cleaned = cleaned.replace(/^--require\s+\S+/g, '').replace(/^--require=\S+/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? undefined : cleaned;
}

if (isMain(import.meta.url, process.argv[1])) {
  const sep = process.argv.indexOf('--');
  const [cmd, ...args] = sep >= 0 ? process.argv.slice(sep + 1) : [];
  if (!cmd) {
    console.error('用法：node scripts/run-clean-node.mjs -- <命令> [参数…]');
    process.exit(127);
  }
  const cleanEnv = { ...process.env };
  const stripped = stripRequire(process.env.NODE_OPTIONS);
  if (stripped === undefined) {
    delete cleanEnv.NODE_OPTIONS;
  } else {
    cleanEnv.NODE_OPTIONS = stripped;
  }
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: cleanEnv });
  process.exit(r.status ?? (r.signal !== null ? 128 : 1));
}
