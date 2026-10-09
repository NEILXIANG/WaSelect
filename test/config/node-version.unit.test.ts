/**
 * 职责：Node 主版本的**同源**与**本机闸门**（AJ-238）。
 *
 * @why 2026-09-30 第二轮审查（DB2-02）实测：本机 `node -v` 是 v25.3.0，而 `.nvmrc` / `engines`
 *      要求 22.x、CI 与 Render 也都是 22——**本机每一次 gate 都跑在 Node 25 上**，
 *      而仓库里没有任何东西会为此报错（没有 engine-strict，`npm install` 只给一条警告）。
 *      同一份 lockfile 里 vitest 5 的 engines 是 `^22.12.0 || ^24.0.0 || >=26.0.0`，**明确不含 25**。
 *      "本地绿"的含义因此是"在一个生产不用、测试框架声明不支持的运行时上绿"：
 *      v8 覆盖率的分支计数随 V8 版本变，逐文件 100% 的门槛在 25 上过不等于在 22 上过；
 *      注释里全部 `@measured` 的 Node 行为也是在 25 上测的；将来写进 23+ 才有的 API 时本机全绿。
 *      约束九：纪律要翻译成会失败的检查——这里就是那条检查。
 *
 * @limitation 只比**主版本**（22）。次版本差异（22.12 与 22.22）不拦：CI 用的是"22 的最新"，
 *              钉死次版本会让每次 Node 发小版本都要改仓库。
 * @see scripts/assert-node-version.mjs；package.json（`check:node` 是 gate 的第一步）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// 被测的是纯 JS 脚本（`node` 直接跑，不经 tsx）——allowJs 已开
import { checkNodeVersion, wantedMajor } from '../../scripts/assert-node-version.mjs';

const ROOT = join(import.meta.dirname, '../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('checkNodeVersion（比主版本）', () => {
  it('主版本一致 → ok（带不带 v 前缀、次版本是多少都行）', () => {
    expect(checkNodeVersion('22.22.2', '22').ok).toBe(true);
    expect(checkNodeVersion('v22.12.0', '22').ok).toBe(true);
    expect(checkNodeVersion('22.0.0', '22\n').ok).toBe(true);
  });

  it('🔴 主版本不一致 → 不 ok，且消息里同时有"现在是几""应该是几"和怎么换', () => {
    const r = checkNodeVersion('25.3.0', '22');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('25.3.0');
    expect(r.message).toContain('22');
    expect(r.message).toContain('.nvmrc');
    // 低于要求同样拦
    expect(checkNodeVersion('20.11.0', '22').ok).toBe(false);
  });

  it('认不出版本号 → 不 ok（宁可拦下，也不把"读不懂"当成"没问题"）', () => {
    expect(checkNodeVersion('', '22').ok).toBe(false);
    expect(checkNodeVersion('22.1.0', '').ok).toBe(false);
    expect(checkNodeVersion('abc', 'lts/*').ok).toBe(false);
  });
});

describe('Node 主版本只有一个来源（五处写的必须是同一个数）', () => {
  const nvmrc = wantedMajor(read('.nvmrc'));

  it('自检：.nvmrc 读得出一个主版本', () => {
    expect(nvmrc).toMatch(/^\d+$/);
  });

  it('package.json engines 的下界主版本 = .nvmrc', () => {
    const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines
      .node;
    expect(/>=\s*(\d+)/.exec(engines)?.[1]).toBe(nvmrc);
    // 上界把下一个主版本挡在外面（`>=22 <23`），否则 engines 自己就允许 25
    expect(/<\s*(\d+)/.exec(engines)?.[1]).toBe(String(Number(nvmrc) + 1));
  });

  it('CI 的 node-version = .nvmrc', () => {
    expect(/node-version:\s*'?(\d+)'?/.exec(read('.github/workflows/ci.yml'))?.[1]).toBe(nvmrc);
  });

  it('render.yaml 里**每一处** NODE_VERSION = .nvmrc（web 与 cron 各一处）', () => {
    const found = [
      ...read('render.yaml').matchAll(/key:\s*NODE_VERSION\s*\n\s*value:\s*'?(\d+)'?/g),
    ].map((m) => m[1]);
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(new Set(found)).toEqual(new Set([nvmrc]));
  });
});

describe('闸门接线（写了脚本却没人调 = 没有闸门）', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  it('check:node 指向这份脚本，且是 gate 的**第一步**（版本不对时后面跑什么都不算数）', () => {
    expect(pkg.scripts['check:node']).toBe('node scripts/assert-node-version.mjs');
    expect((pkg.scripts['gate'] ?? '').startsWith('npm run check:node && ')).toBe(true);
  });

  it('pre-commit 也先过这一步（钩子只调 gate:fast，gate:fast 的第一步是 check:node，AJ-423）', () => {
    const hook = read('scripts/pre-commit');
    const lines = hook.split('\n').filter((l) => /^npm run /.test(l));
    expect(lines).toEqual(['npm run gate:fast']);
    expect((pkg.scripts['gate:fast'] ?? '').startsWith('npm run check:node && ')).toBe(true);
  });
});

/**
 * INF3-02（第三轮审查）：入口判断要穿透软链。
 * @why 原来按字符串比 argv[1]，经软链直接执行时闸门静默 exit 0。
 */
describe('isMain（scripts/is-main.mjs）', () => {
  it('经软链执行也认作入口；被别的入口 import 时不认', async () => {
    const { isMain } = await import('../../scripts/is-main.mjs');
    const { mkdtempSync, symlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const real = resolve(import.meta.dirname, '../../scripts/assert-node-version.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
    const link = join(dir, 'gate.mjs');
    symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    expect(isMain(url, link)).toBe(true);
    expect(isMain(url, real)).toBe(true);
    expect(isMain(url, resolve(import.meta.dirname, '../../package.json'))).toBe(false);
    expect(isMain(url, undefined)).toBe(false);
  });
});
