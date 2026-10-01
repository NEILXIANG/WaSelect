/**
 * 职责：checkout 静态站的**部署清单**一致性（B3）。
 *
 * @why Cloudflare Pages 没有 IaC——平台的"构建命令 / 发布目录 / 环境变量"都是控制台里手填的
 *      三行，改错了不报错：发布目录填错 = 发了一个空站点（页面全 404），
 *      构建命令漏 `--include=dev` = `tsx` 不在，构建直接失败且报错指向别的方向。
 *      这类缺口此前（B3 之前的盘点）正是"checkout 静态站没有部署目标"的全部内容。
 *      `deploy/cloudflare-pages.json` 是仓库里那份真源，本文件把它钉住：
 *      清单与代码不一致时**这里红**，而不是等用户说"付款链接坏了"。
 *
 * @how 纯 fs + JSON.parse，不引任何依赖；与 `render-env.unit.test.ts` 同手法（那里管 Render 侧）。
 *
 * @limitation 它保证的是"清单与代码一致"，**保证不了平台上真的照它填了**——
 *              那一步只能靠首次部署后的手验（清单 `notes` 里写了验法）。
 *
 * @see ../../deploy/cloudflare-pages.json；../../scripts/checkout-build-lib.ts；
 *      docs/自主决策记录.md AJ-279
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKOUT_DIST_DIR } from '../../scripts/checkout-build-lib.js';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(
  readFileSync(resolve(root, 'deploy/cloudflare-pages.json'), 'utf8'),
) as {
  project: string;
  buildCommand: string;
  outputDirectory: string;
  buildEnvVars: string[];
};

describe('Cloudflare Pages 部署清单（checkout 静态站，B3）', () => {
  it('清单读得出且字段齐全（防"文件改名/字段拼错 → 下面断言静默失效"）', () => {
    expect(typeof manifest.project).toBe('string');
    expect(manifest.project.length).toBeGreaterThan(0);
    expect(typeof manifest.buildCommand).toBe('string');
    expect(Array.isArray(manifest.buildEnvVars)).toBe(true);
  });

  /**
   * @why 发布目录必须与构建脚本写入的目录**是同一个常量**。
   *      两边各写一份时，改了一处另一处不报错——产物被发布到旁边一个空目录，
   *      站点表现是"所有页面 404"，而构建是全绿的（`@limitation 一`的同款形态）。
   */
  it('发布目录 = 构建脚本的产物目录（填错 = 发一个空站点，且构建照样成功）', () => {
    expect(manifest.outputDirectory).toBe(CHECKOUT_DIST_DIR);
    expect(manifest.outputDirectory).toBe('checkout-static/dist');
  });

  /**
   * @why `--include=dev` 不是可选项：`build:checkout` 用 `tsx` 跑脚本，而 tsx 是
   *      devDependency；CF Pages 构建环境的 NODE_ENV 会让 npm 默认 omit=dev
   *      （与 render.yaml 里那处同款坑，@measured 见那里的注释）。
   *      漏了它的报错是 `tsx: not found`，排查方向会被带到"脚本写错了"。
   */
  it('构建命令装 devDependencies 且跑 build:checkout', () => {
    expect(manifest.buildCommand).toMatch(/npm ci --include=dev/);
    expect(manifest.buildCommand).toMatch(/npm run build:checkout/);
  });

  it('构建期变量含 PUBLIC_API_BASE（_redirects 的第一跳目标；漏配会让短链指向 localhost）', () => {
    expect(manifest.buildEnvVars).toContain('PUBLIC_API_BASE');
    expect(manifest.buildEnvVars).toContain('NODE_VERSION');
  });
});
