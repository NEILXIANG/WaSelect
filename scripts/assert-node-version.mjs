/**
 * 职责：本机 Node 主版本闸门——与 `.nvmrc` 不一致就拒绝往下跑（gate 与 pre-commit 的第一步，AJ-238）。
 *
 * @why `engines` 写了 `>=22 <23`，但 npm 默认只在 `npm install` 时给一条**警告**，之后再不提。
 *      实测（2026-09-30）：本机是 Node 25.3.0，gate 跑了几十次全绿，没有任何东西指出
 *      "这不是生产用的运行时"。而 CI 与 Render 都是 22 ⇒ 本机绿 ≠ CI 绿 ≠ 生产行为。
 *      纯 JS、零依赖、用 `node` 直接跑：它必须在装依赖、起 tsx 之前就能执行。
 *
 * @why 不用 `.npmrc` 的 `engine-strict=true`：那只拦 `npm install`，拦不住"装完之后换了 Node 再跑"；
 *      而且它会让不相干的传递依赖的 engines 声明也变成硬错误，误伤面不可控。
 *
 * @limitation 一：只比主版本（理由见 test/config/node-version.unit.test.ts 的 @limitation）。
 * @limitation 二：没有跳过开关。@why 这类闸门一旦有 `SKIP_…=1`，它就会出现在每个人的 shell 配置里；
 *              真需要临时用别的版本跑某一条命令，直接跑那条命令即可（闸门只挂在 gate 与 pre-commit 上）。
 *
 * @see .nvmrc；package.json `engines` / `check:node`；test/config/node-version.unit.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 `.nvmrc` 的内容里取主版本；认不出返回空串。 */
export function wantedMajor(nvmrc) {
  const m = /^v?(\d+)(?:\.\d+){0,2}\s*$/.exec(String(nvmrc).trim());
  return m?.[1] ?? '';
}

/**
 * @param {string} current `process.versions.node`（如 `25.3.0`；带 `v` 前缀也认）
 * @param {string} nvmrc `.nvmrc` 的内容
 * @returns {{ok: boolean, message: string}}
 */
export function checkNodeVersion(current, nvmrc) {
  const want = wantedMajor(nvmrc);
  const have = /^v?(\d+)\./.exec(String(current))?.[1] ?? '';
  if (want === '' || have === '') {
    return {
      ok: false,
      message: `无法判断 Node 版本（当前 "${current}"，.nvmrc "${String(nvmrc).trim()}"）——按不通过处理。`,
    };
  }
  if (want === have) return { ok: true, message: '' };
  return {
    ok: false,
    message:
      `Node 主版本不对：当前 ${current}，本仓库要求 ${want}.x（.nvmrc / engines / CI / Render 都是 ${want}）。\n` +
      `在别的主版本上跑出来的"全绿"不能当作完成判定。换到 ${want} 再跑，例如：\n` +
      `  nvm install ${want} && nvm use        # 读 .nvmrc\n` +
      `  或  brew install node@${want} && brew link --overwrite --force node@${want}`,
  };
}

// 作为脚本直接运行时才执行检查（被测试 import 时不执行）
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = checkNodeVersion(
    process.versions.node,
    readFileSync(join(root, '.nvmrc'), 'utf8'),
  );
  if (!result.ok) {
    console.error(`\n✗ ${result.message}\n`);
    process.exit(1);
  }
}
