/**
 * 职责：数据库备份文件不得进入 Git 索引（四天提交复查 2026-10-16，AJ-534）。
 *
 * @why 真实事故：ebc7c6a 把一份 1MB 的开发库 pg_dump（`var/backup/japan_shop-before-cleanup-….dump`）
 *      随代码一起提交并推到了远端——内含全部开发数据与一个管理员口令哈希。f4e70c7 取消跟踪并加了 .gitignore，
 *      但 .gitignore 只管"没加过的文件"，`git add -f` 或换个目录名照样进得去。
 * @why 查的是 `git ls-files`（索引）而不是工作区：暂存区里的新文件也在索引里，所以提交钩子（gate:fast → test:guards）
 *      在 commit 那一刻就能拦住；工作区里放着备份（本机恢复要用）不算违规。
 * @limitation 只认文件名形态（扩展名 / 目录）；改名成 `.txt` 的备份认不出——那需要内容扫描，代价与误报都高，
 *             现阶段按"有事故才加守卫"只防这一次真实发生过的形态。
 * @see docs/自主决策记录.md AJ-534
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** 备份文件的形态：pg_dump 自定义格式 / 压缩 SQL / 本项目的备份目录。 */
const DB_BACKUP_RE = /(\.(dump|pgdump|backup|sql\.gz|sql\.zst)$)|(^|\/)var\/backup\//i;

describe('数据库备份不进仓库', () => {
  it('判据认得出那次真实事故的路径，也不误伤普通 SQL 迁移（否则下面那条是假绿灯）', () => {
    expect(DB_BACKUP_RE.test('var/backup/japan_shop-before-cleanup-20261012-224033.dump')).toBe(
      true,
    );
    expect(DB_BACKUP_RE.test('tmp/prod.sql.gz')).toBe(true);
    expect(DB_BACKUP_RE.test('server/migrations/040_late_paid_event_unique.sql')).toBe(false);
  });

  it('🔴 Git 索引里没有数据库备份文件（含已暂存未提交的）', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter((f) => f !== '');
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) => DB_BACKUP_RE.test(f));
    expect(
      offenders,
      `数据库备份进了 Git 索引：${offenders.join(', ')}\n` +
        '备份里是整库数据（含口令哈希），推到远端就收不回来了——请 `git rm --cached <文件>`，备份留在本机即可。',
    ).toEqual([]);
  });
});
