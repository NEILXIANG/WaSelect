/**
 * 职责：admin-web 的部署环境闸门（二次审查 P2：N16 同款缺口在 admin-web 侧的补齐）。
 *
 * @why admin-web 与 checkout-static 同属「CF Pages 无 IaC」形态：`VITE_API_BASE_URL` 漏配时
 *      `resolveApiBase` 静默回落 `http://localhost:3000`（admin-web/src/api/config.ts），
 *      构建照样成功、产物里烤着 localhost——管理端上线即全灭，且不报 CORS 错
 *      （请求打在静态站自己身上，全是 404）。checkout 侧已有 `assertDeployApiBase`，
 *      这里把同一闸门接到 admin-web 的 prebuild。
 *
 * @limitation 只在 CF Pages 环境生效（平台注入 `CF_PAGES`）；本地/CI 构建故意允许
 *             localhost（联调要用）。Vite 的 envDir 是 admin-web/——仓库根的 .env
 *             **不会**被它加载，所以这里直接读 `process.env`（prebuild 由 npm 注入环境）。
 *
 * @see scripts/checkout-build-lib.ts（assertDeployApiBase）；admin-web/package.json prebuild
 */
import { assertDeployApiBase } from './checkout-build-lib.js';

const base = process.env.VITE_API_BASE_URL ?? '';
if (process.env.CF_PAGES !== undefined) {
  assertDeployApiBase(base, 'VITE_API_BASE_URL');
}
process.stdout.write(
  `[assert-admin-deploy-env] VITE_API_BASE_URL=${base || '(未设置，本地默认)'}\n`,
);
