/**
 * 职责：提交门禁的"门禁"（N18）——pre-commit 与 prepare 钩子的结构断言。
 *
 * @why pre-commit 是整个质量体系的**第一公里**：它漏跑一类检查，这类检查就事实上不存在
 *      （开发者不会每次手跑 gate）。而它自己只是个 shell 脚本，没有任何东西替它兜底——
 *      曾经它就只是 lint+typecheck，单测完全不在提交门禁里（"提交时绿的、CI 才红"的
 *      反馈环要慢几十分钟）。这类"接线断掉"的缺陷只有结构断言能每跑必查。
 *
 * @see docs/地基搭建清单.md F0/F1；CLAUDE.md（无测试不前进）
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

describe('提交门禁接线（N18）', () => {
  const hook = readFileSync(join(root, 'scripts', 'pre-commit'), 'utf8');
  const pkgScripts = (
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    }
  ).scripts;
  /**
   * AJ-423：钩子只调用 `npm run gate:fast`（不再抄写步骤），下面"跑快速单测 / 保留 lint 与 typecheck"
   * 两条性质改在唯一真源 gate:fast 上断言——不是放宽：钩子调用 gate:fast 由第一条钉住，步骤由后两条钉住。
   */
  const fast = (pkgScripts?.['gate:fast'] ?? '').split('&&').map((x) => x.trim());

  it('pre-commit 调用 gate:fast（单一真源）', () => {
    expect(hook).toContain('npm run gate:fast');
  });

  it('pre-commit 跑快速单测（test:fast）——提交时就要红，不等 CI', () => {
    expect(fast).toContain('npm run test:fast');
  });

  it('pre-commit 保留 lint 与 typecheck（回归：加新检查不能挤掉旧的）', () => {
    expect(fast).toContain('npm run lint');
    expect(fast).toContain('npm run typecheck');
  });

  it('pre-commit 可执行（ chmod 丢了钩子就静默失效）', () => {
    const mode = statSync(join(root, 'scripts', 'pre-commit')).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('package.json 有 prepare 钩子自动接 core.hooksPath（克隆后手工配置=必然有人忘）', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.prepare).toContain('core.hooksPath');
    expect(pkg.scripts?.prepare).toContain('scripts');
  });
});
