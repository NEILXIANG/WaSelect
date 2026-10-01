/**
 * 职责：判断一个 `.mjs` 脚本是否作为进程入口被直接执行（ESM 没有 `require.main`）。
 *
 * @why 第三轮审查 INF3-02：Node 版本闸门原来比较 `fileURLToPath(import.meta.url) === argv[1]`。
 *      经软链路径直接执行（`node ./link-to/assert-node-version.mjs`，或 macOS 的 /var → /private/var）时
 *      两边字符串不等 → 被当成"被 import" → 检查不执行、直接 exit 0。
 *      @measured（2026-09-30，第三轮审查探针，系统 Node 25.3.0）：经软链执行 → exit 0，无任何输出。
 *      与 `server/src/main.ts` 的 `isSelfEntry` 同一做法：两边都过 realpathSync。
 * @why 与 main.ts 相反的一点：realpath 失败时这里按**是入口**处理。
 *      main.ts 判不准时宁可不启动服务；而这里的调用方是**门禁脚本**，判不准时宁可执行检查——
 *      门禁"静默不跑"比"多跑一次"贵得多。被测试 import 时 argv[1] 是 vitest 自己的入口，realpath 都成功且不相等，不受影响。
 *
 * @param {string} metaUrl 调用方的 `import.meta.url`
 * @param {string | undefined} argv1 `process.argv[1]`
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl, argv1) {
  if (argv1 === undefined) return false;
  const self = fileURLToPath(metaUrl);
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return true;
  }
}
