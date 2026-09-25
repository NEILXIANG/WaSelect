/**
 * 职责：断言 `gate` 这道门禁**没有被瘦身、也没有被塞进会卡死它的审计**（F16 第二单元）。
 *
 * @why `gate` 是本项目唯一的"完成"判据（CLAUDE.md：判定完成只有一个信号——全量 gate 的 exit code）。
 *      而它自己**没有任何东西在守着**：从里面删掉一层（比如 `test:db`），
 *      不会报错、不会红、只是那一层从此再也没有跑过——
 *      **"门禁在跑"与"门禁在漏"长得一模一样**，这正是本项目反复出现的那类失效。
 *      更隐蔽的是删掉之后**剩下的仍然全绿**，于是没人会问"是不是少了什么"。
 *
 * @why 单独钉一条"审计必须是生产面"：把**全量** `npm audit` 放进 gate 的后果是
 *      dev-only 的传递漏洞（当前是 `miniprogram-simulate` → postcss）会永久卡住发布，
 *      而 `npm audit fix --force` 给出的"修复"是把 simulate **降级**到 0.0.1——
 *      那会直接毁掉组件级测试。**一个会让人在慌乱中点 `--force` 的门禁，比没有门禁更危险。**
 *      所以进 gate 的只能是我们能修且必须修的那一半（server 的运行时依赖）。
 *
 * @how 纯 JSON 读取 + 字符串解析，不做 shell 解析（gate 是我们自己写的，形态固定）。
 *
 * @limitation 一：只验"步骤名出现在 gate 里"，**不验顺序**。
 *              顺序当前是"快的先跑"（格式/lint/类型 → 构建 → 测试 → 覆盖率），
 *              但它不改变覆盖范围，改顺序不该红。
 * @limitation 二：名单是**手写**的，新增一层必须同步加到这里。
 *              @why 不自动枚举 `scripts` 里所有键：那会把 `lint:fix` / `format` / `start`
 *                  这类非校验命令也算成必需步骤，于是"必需"这个词就没有意义了。
 *
 * @see ../../package.json（gate 定义）；../../CLAUDE.md；docs/地基搭建清单.md F16
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** gate 里必须出现的步骤（@see @limitation 二）。 */
const REQUIRED_STEPS: readonly string[] = [
  'format:check',
  'lint',
  'typecheck',
  'build',
  'build:checkout',
  'check:contract',
  'test:unit',
  'test:db',
  'test:contract',
  'test:e2e',
  'test:lint',
  'audit:prod',
  'cov',
];

/**
 * gate 里缺失的步骤名。
 * @why 结尾必须"后面既不是词字符、也不是 `:` / `-`"。
 *      ⚠️ 单用 `\b` **不够**：`npm run lint:fix` 里 `lint` 后面是 `:`（非词字符），
 *      `\b` 照样匹配——于是"把 `lint` 换成 `lint:fix`"这种瘦身**看不出来**
 *      （`lint:fix` 是自动修，永远不红，等于那一层没了）。这是自检抓出来的，不是我预想到的。
 */
function missingSteps(gate: string, required: readonly string[]): string[] {
  return required.filter((step) => !new RegExp(`npm run ${step}(?![\\w:-])`).test(gate));
}

/** gate 里是否混进了**全量**审计（那会卡死发布）。 */
function hasFullAudit(gate: string): boolean {
  return /(^|&&\s*)npm audit(\s|$)/.test(gate);
}

const gate = pkg.scripts['gate'] ?? '';

describe('gate 这道门禁本身必须完整', () => {
  it('gate 存在且非空，必需步骤名单也非空（防"空对空"）', () => {
    expect(gate.length).toBeGreaterThan(20);
    expect(REQUIRED_STEPS.length).toBeGreaterThanOrEqual(10);
  });

  it('每一层都在 gate 里（删掉任何一层都不会报错，只能靠这条兜住）', () => {
    const missing = missingSteps(gate, REQUIRED_STEPS);
    expect(
      missing,
      `gate 里少了这些步骤——它们从此不会在"完成判定"里跑过：\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('gate 里的审计是**生产面**的（全量审计会被 dev-only 传递漏洞永久卡死）', () => {
    expect(hasFullAudit(gate), 'gate 里出现了 `npm audit`（全量）——必须用 audit:prod').toBe(false);
    expect(/npm run audit:prod\b/.test(gate)).toBe(true);
  });

  it('audit:prod 的口径正确：只审生产面、且只让高危红', () => {
    // @why 这两个参数各少一个都会让这条门禁变成另一种东西：
    //      少了 `--omit=dev` → 变回全量（卡死发布）；
    //      少了 `--audit-level=high` → moderate 也会红，于是"能不能发布"取决于 npm 的告警分级，
    //      而那个分级会随 advisory 数据库变动——今天绿的明天红，且不是我们改的代码引起的。
    const auditProd = pkg.scripts['audit:prod'] ?? '';
    expect(auditProd).toContain('--omit=dev');
    expect(auditProd).toContain('--audit-level=high');
  });

  it('同时保留一份人工可跑的全量审计（dev 面的漏洞要看得见，只是不卡发布）', () => {
    // @why 只留生产面审计会让 dev 依赖的漏洞彻底消失在视野里——
    //      那条 postcss 公告（GHSA-7fh5-64p2-3v2j 等）现在就是靠这个命令看见的。
    //      "不进 gate"不等于"不看"，所以把它钉成一条显式存在的脚本。
    expect(pkg.scripts['audit']).toBe('npm audit');
  });

  it('自检：删一层 / 混进全量审计，检查函数都真的会报（防"检查写坏 → 永远绿"）', () => {
    // @why 上面四条全部依赖 missingSteps / hasFullAudit。它们写坏的最可能后果
    //      不是报错，而是**永远返回空 → 所有断言永真**（本项目第四次以上踩同一形态）。
    const sample = 'npm run lint && npm run typecheck && npm run cov';
    expect(missingSteps(sample, REQUIRED_STEPS)).toContain('test:db');
    expect(missingSteps(sample, REQUIRED_STEPS)).toContain('audit:prod');
    // ⚠️ `lint` 不能命中 `lint:fix`：这条防的是"把 lint 换成 lint:fix"那种瘦身
    expect(missingSteps('npm run lint:fix && npm run typecheck', ['lint'])).toEqual(['lint']);
    expect(hasFullAudit('npm run lint && npm audit && npm run cov')).toBe(true);
    expect(hasFullAudit('npm run lint && npm run audit:prod && npm run cov')).toBe(false);
  });

  it('admin-web 的 prebuild 必须挂部署环境闸门（二次审查 P2：N16 同款缺口，拆掉闸门不报错）', () => {
    /**
     * @why admin-web 与 checkout-static 同属「CF Pages 无 IaC」形态：VITE_API_BASE_URL 漏配时
     *      产物静默烤进 localhost。闸门脚本存在但**没被 prebuild 引用**是最可能的失效形态
     *      （加一个脚本很容易，把它挂进构建链很容易忘）——所以这里钉的是"接线"，不是脚本本身。
     */
    const adminPkg = JSON.parse(readFileSync(resolve(root, 'admin-web/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(adminPkg.scripts['prebuild']).toContain('assert-admin-deploy-env');
  });
});
