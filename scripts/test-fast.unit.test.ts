/**
 * 职责：`scripts/test-fast.mjs` 的判定——哪些改动要跑全部 unit 用例。
 *
 * @why 4ef8991 只改了 app.css（写了 `3px`），`--changed` 按 import 关系找不到设计令牌用例，提交钩子全绿、main 上是红的
 *      （测试缺口复盘 2026-10-12）。这里钉住"改 css / wxss / wxml / md / json 就跑全部"。
 * @why 34c5a41 把一条红的"源码文本断言"带进了 main（2026-10-13）：改动集里有中文名的
 *      `docs/自主决策记录.md`，但 `git diff --name-only` 默认（`core.quotePath=true`）把它输出成
 *      `"docs/\350…\345\275\225.md"`（**引号 + 八进制**），`\.md$` 匹配不到 → 安全网静默失效 → 走 `--changed`
 *      → 那条 `readFileSync` 读实现的用例（不在 import 图里）一条没跑。最后那个用例用**真的 git** 走一遍，
 *      钉住"路径必须原样到达这里"。@see docs/自主决策记录.md AJ-523
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFiles, needsFullUnit, parseNulPaths } from './test-fast.mjs';

/** 仓库根（本文件在 scripts/ 下）。 */
const root = join(import.meta.dirname, '..');

describe('needsFullUnit', () => {
  it.each([
    ['admin-web/src/app.css'],
    ['miniprogram/pages/cart/index.wxss'],
    ['miniprogram/pages/order-detail/index.wxml'],
    ['docs/测试缺口复盘-2026-10-12.md'],
    ['miniprogram/app.json'],
    ['contracts/api-contract.yaml'],
    ['migrations/040_x.sql'],
  ])('🔴 %s → 跑全部 unit（这类文件由单测按内容读取，不在 import 图里）', (f) => {
    expect(needsFullUnit(['server/src/x.ts', f])).toBe(true);
  });

  it('只改 ts / js / tsx → 只跑受影响的', () => {
    expect(
      needsFullUnit([
        'server/src/domain/address-input.ts',
        'miniprogram/utils/price-format.js',
        'admin-web/src/orders/OrdersPage.tsx',
      ]),
    ).toBe(false);
    expect(needsFullUnit([])).toBe(false);
  });

  // 三天提交复查 2026-10-12：小程序页面薄壳（pages/*/index.js）由壳用例按 URL 动态加载、守卫另由 test:guards 全跑，
  //   都不在 import 图里——只改 index.js 时它们一条不跑
  it('🔴 改了小程序页面薄壳 index.js → 跑全部 unit', () => {
    expect(needsFullUnit(['miniprogram/pages/cart/index.js'])).toBe(true);
    expect(needsFullUnit(['miniprogram/pages/cart/index.vm.js'])).toBe(false);
  });

  it('parseNulPaths：按 NUL 切、丢空段（`-z` 输出才是原样路径）', () => {
    expect(parseNulPaths('a\0b/c\0')).toEqual(['a', 'b/c']);
    expect(parseNulPaths('')).toEqual([]);
  });

  // 34c5a41 漏检的形状（2026-10-13）：改动集里有中文名文件，可 git 默认输出把它包成
  //   `"docs/\350…"`，`\.md$` 就匹配不到了 —— 安全网静默不生效，红的提交进了 main。
  //   这里用**真的 git** 走一遍：造一个中文名未跟踪文件，要求它**原样**出现在改动集里。
  it('🔴 中文名文件原样到达（被引号 / 八进制包住就是漏检的形状）', () => {
    const probe = join(root, 'var', 'probe-中文名.md');
    mkdirSync(dirname(probe), { recursive: true });
    writeFileSync(probe, 'probe\n');
    try {
      const changed = changedFiles();
      expect(changed, '改动集里必须是原样路径，不能是 "…\\350…" 这种').toContain(
        'var/probe-中文名.md',
      );
      expect(needsFullUnit(changed)).toBe(true);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
