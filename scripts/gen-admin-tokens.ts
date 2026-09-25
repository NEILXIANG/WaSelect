/**
 * 职责：生成 admin-web 的 tokens.css（F15 单元③）——design token 颜色从 shared 单源物化。
 *      刻意薄：全部逻辑在 checkout-build-lib.ts 的 renderTokensCss（F15 单元①，17 条单测钉住）。
 *
 * 产物：admin-web/src/tokens.css（已被 .gitignore 排除——生成物不入库，与 checkout-static/dist 同口径）。
 *
 * 触发方式：admin-web 的 `predev` / `prebuild`（npm 的 pre* 钩子自动跑），
 *   即 `npm run dev -w admin-web` 与 `npm run build -w admin-web` 之前必然重新生成。
 *   「忘跑脚本 → 用旧 token」这个失效形态由钩子的存在性断言钉住（design-token.unit.test.ts）。
 *
 * @why 不手写 tokens.css 靠测试绑值（小程序 RELOGIN_CODE 套路）：那是"两处真值 + 测试提醒"，
 *      而生成物模式是"一处真值 + 物化"——admin-web 是新端，没有历史包袱，直接上更硬的那种。
 * @limitation 产物被 gitignore 意味着 fresh clone 后首次 typecheck 时文件不存在——
 *             不红：css import 走 vite/client 的 ambient 模块声明（tsc 不查文件存在性），
 *             vite build 前 prebuild 已生成。这条链任一环节断掉的表现是 vite build 红，不是静默。
 *
 * @see scripts/checkout-build-lib.ts（renderTokensCss）；packages/shared/src/design-tokens.ts（颜色真源）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS_COLORS } from '@waselect/shared';
import { renderTokensCss } from './checkout-build-lib.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'admin-web', 'src');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'tokens.css'), renderTokensCss(WS_COLORS, 'gen-admin-tokens'), 'utf8');
process.stdout.write('[gen-admin-tokens] admin-web/src/tokens.css 已生成\n');
