/**
 * 职责：守卫——每条管理端路由的路径参数，审计中间件都取得到（`admin-audit.ts` 的 target）。
 *
 * @why 真实事故（AJ-497，2026-10-12 全入口点击测试）：审计中间件只取 `:id`，注释写着"全库管理端路由的路径参数一律叫 id"；
 *      AJ-491 加分类路由时用了 `:key`，改分类 / 删分类的审计行 target 全是 NULL——运营日志"对象"一栏写"—"，
 *      查不出改的是哪一类。现在中间件在没有 `:id` 时取**唯一的**那个路径参数；本守卫钉住它能成立的前提：
 *      每条管理端路由要么有 `:id`，要么只有一个路径参数。多参数又没有 `:id` 的新路由会在这里红。
 * @why 按源码扫路径字符串（CLAUDE.md：扫描型守卫只为真实事故加——这是一条）：运行期拿到的路由表
 *      （`collectAppRoutes`）把参数名归一成 `{}`，看不到名字。
 * @limitation 只认 `'/api/v1/admin/…'` 这种写在一行里的字符串字面量；拼接出来的路径看不到（目前没有）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(import.meta.dirname, '.');

const adminRoutePaths = (): Array<{ file: string; path: string }> =>
  readdirSync(APP_DIR)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .flatMap((file) =>
      [
        ...readFileSync(join(APP_DIR, file), 'utf8').matchAll(/'(\/api\/v1\/admin\/[^']*:[^']*)'/g),
      ].map((m) => ({ file, path: m[1] ?? '' })),
    );

describe('管理端路由的路径参数审计中间件都取得到（AJ-497）', () => {
  it('扫得到带参数的管理端路由（扫描没失效）', () => {
    const paths = adminRoutePaths().map((r) => r.path);
    expect(paths).toContain('/api/v1/admin/orders/:id');
    expect(paths).toContain('/api/v1/admin/categories/:key');
  });

  it('🔴 每条要么有 :id，要么只有一个路径参数', () => {
    const bad = adminRoutePaths().filter(({ path }) => {
      const params: string[] = path.match(/:[A-Za-z]+/g) ?? [];
      return !params.includes(':id') && params.length !== 1;
    });
    expect(bad).toEqual([]);
  });
});
