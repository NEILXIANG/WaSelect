/**
 * 职责：admin-web 的部署环境闸门（二次审查 P2：N16 同款缺口在 admin-web 侧的补齐）。
 *
 * @why admin-web 与 checkout-static 同属「静态站托管无 IaC」形态：`VITE_API_BASE_URL` 漏配时
 *      `resolveApiBase` 静默回落 `http://localhost:3000`（admin-web/src/api/config.ts），
 *      构建照样成功、产物里烤着 localhost——管理端上线即全灭，且不报 CORS 错
 *      （请求打在静态站自己身上，全是 404）。checkout 侧已有 `assertDeployApiBase`，
 *      这里把同一闸门接到 admin-web 的 prebuild。
 *
 * @why 2026-10-01 修订（B2）：判定从"只看 `CF_PAGES`"改为 `isDeployBuild()`。
 *      admin-web 的部署目标是 **Render Static Site**（写进 `render.yaml`，受
 *      `test/config/render-env.unit.test.ts` 覆盖），而 Render **不注入** `CF_PAGES`
 *      ——沿用旧判据的话这道闸在 Render 上**完全不生效**，等于没有。
 *      新增的 `DEPLOY_TARGET` 是我们在 render.yaml 里显式声明的哨兵，不依赖猜平台行为。
 *
 * @limitation 本机/CI 联调构建故意允许 localhost（要用）。
 *             Vite 的 envDir 是 admin-web/——仓库根的 .env **不会**被它加载，
 *             所以这里直接读 `process.env`（prebuild 由 npm 注入环境），
 *             而真正烤进产物的是 Vite 自己读到的 `VITE_API_BASE_URL`——
 *             ⚠️ 两者必须是同一个进程环境，改 prebuild 调用方式时要留意。
 *
 * @see scripts/checkout-build-lib.ts（assertDeployApiBase / isDeployBuild）；
 *      admin-web/package.json prebuild；render.yaml（waselect-admin 静态站）
 */
import { assertDeployApiBase, isDeployBuild } from './checkout-build-lib.js';

const base = process.env.VITE_API_BASE_URL ?? '';
if (isDeployBuild()) {
  assertDeployApiBase(base, 'VITE_API_BASE_URL');
}
process.stdout.write(
  `[assert-admin-deploy-env] VITE_API_BASE_URL=${base || '(未设置，本地默认)'}` +
    `${isDeployBuild() ? '（部署构建：已校验）' : '（本机构建：允许 localhost）'}\n`,
);
