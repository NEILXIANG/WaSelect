/**
 * 职责：checkout-static 构建 CLI（F15 单元①）——只做「读环境 → 生成/复制 → 打印」。
 *      所有可被测试的逻辑都在 checkout-build-lib.ts；本文件刻意薄。
 *
 * 产物（checkout-static/dist/，已被 .gitignore 的 dist/ 覆盖）：
 *   _redirects            ← renderRedirects(PUBLIC_API_BASE)
 *   assets/tokens.css     ← renderTokensCss(WS_COLORS)
 *   assets/page.css       ← 原样复制
 *   pay/<三张>/index.html ← renderPage（品牌名替换）
 *
 * 用法：
 *   npm run build:checkout                          # 缺省 PUBLIC_API_BASE=http://localhost:3000
 *   PUBLIC_API_BASE=https://api.example.com npm run build:checkout
 *
 * @see scripts/checkout-build-lib.ts（全部逻辑与理由）；docs/地基搭建清单.md F15
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS_COLORS } from '@waselect/shared';
import {
  assertDeployApiBase,
  CHECKOUT_DIST_DIR,
  CHECKOUT_PAGES,
  isDeployBuild,
  renderPage,
  renderRedirects,
  renderTokensCss,
} from './checkout-build-lib.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'checkout-static');
const dist = join(root, CHECKOUT_DIST_DIR);

function main(): void {
  const envFile = join(root, '.env');
  if (process.env.PUBLIC_API_BASE === undefined && readFileSyncSafe(envFile) !== undefined) {
    process.loadEnvFile(envFile);
  }
  const apiBase = process.env.PUBLIC_API_BASE ?? 'http://localhost:3000';
  // 部署构建（CF Pages 注入 CF_PAGES / Render 由我们声明 DEPLOY_TARGET）：
  // 漏配 PUBLIC_API_BASE 必须响亮失败——产物里的 `_redirects` 会静默指向 localhost
  if (isDeployBuild()) assertDeployApiBase(apiBase);

  rmSync(dist, { recursive: true, force: true }); // 全量重建：产物目录无增量状态
  mkdirSync(join(dist, 'assets'), { recursive: true });

  writeFileSync(join(dist, '_redirects'), renderRedirects(apiBase), 'utf8');
  writeFileSync(join(dist, 'assets', 'tokens.css'), renderTokensCss(WS_COLORS), 'utf8');
  cpSync(join(src, 'assets', 'page.css'), join(dist, 'assets', 'page.css'));

  for (const page of CHECKOUT_PAGES) {
    const html = renderPage(readFileSync(join(src, page, 'index.html'), 'utf8'));
    mkdirSync(join(dist, page), { recursive: true });
    writeFileSync(join(dist, page, 'index.html'), html, 'utf8');
  }

  process.stdout.write(
    `[build:checkout] 产物就绪（API=${apiBase}）：dist/_redirects + tokens.css + ${CHECKOUT_PAGES.length} 张页\n`,
  );
}

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

main();
