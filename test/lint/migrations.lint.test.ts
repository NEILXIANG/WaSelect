/**
 * 职责：迁移文件的**破坏性变更必须显式标注**（第二轮审查 DB2-07）。
 *
 * @why Render 的部署顺序是 `preDeployCommand: npm run db:migrate` **先跑**，
 *      而旧实例在新实例健康之前**继续接流量**（render.yaml 注释 + blueprint 文档）。
 *      于是"迁移完成 → 新实例接管"之间存在一个窗口，窗口里跑的是**旧版本代码**：
 *      · up 段删了列/表 → 旧代码 `select` 一个不存在的列 → 42703 → 50000；
 *      · up 段收紧了约束 → 旧代码写入的新值可能不再合法 → 23514 → 50000。
 *      015 正是前者（up 里 `ALTER TABLE users DROP COLUMN …`），当时生产未上线所以没出事；
 *      同样的手法用到 `orders` / `payments` 上，就是下单路径 500。
 * @why 用**静态检查**钉这件事而不是靠 review：这类缺陷在单人开发阶段
 *      **不会有任何症状**（本地 migrate 完立刻起新代码，窗口长度为 0），
 *      只有上线后才会以"部署期间一阵 500"的形式出现，而那时没人会想到是迁移写的。
 *      检查的成本是"改迁移的人要写一行 @breaking"，收益是把"这一版为什么安全"逼出来——
 *      写不出来就说明它**不安全**。
 *
 * @limitation 一：只判**形态**，不判语义。`ALTER COLUMN … TYPE` 是放宽（008 加长
 *              `terms_version`）还是缩窄，本检查读不出来——缩窄同样是 breaking，
 *              那一类仍要靠 review（本检查的注释里写明，避免"有检查"被当成"全查了"）。
 * @limitation 二：`ADD CONSTRAINT` 一律算收紧，不细分 CHECK / UNIQUE / FK。
 *              细分需要解析约束体，而收益很小：三种都会在窗口里让旧写入失败。
 * @limitation 三：不检查 down 段。down 在生产**不执行**（没有回滚流程），
 *              它的破坏性只影响 up→down→up 的门禁，那由 `migrations.db.test.ts` 覆盖。
 *
 * @see migrations/015_login_attempts.sql（本条规则的起因，文件头已带 @breaking）；
 *      render.yaml（preDeployCommand）；docs/自主决策记录.md AJ-317
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const dir = join(root, 'migrations');

const UP = '-- Up migration';
const DOWN = '-- Down migration';

/** 会让**仍在服务的旧版本代码**失败的语句（up 段里出现即要求标注）。 */
const BREAKING = [
  'DROP COLUMN',
  'DROP TABLE',
  'DROP CONSTRAINT',
  'TRUNCATE',
  'SET NOT NULL',
  'ADD CONSTRAINT',
] as const;

function files(): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function read(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

/** 取 up 段（去注释行后的可执行语句）。 */
function upBody(text: string): string {
  const after = text.split(UP, 2)[1] ?? '';
  const body = after.split(DOWN, 2)[0] ?? '';
  return body
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

/** 文件头 = up 标记之前的全部注释。 */
function header(text: string): string {
  return text.split(UP, 2)[0] ?? '';
}

describe('迁移文件（migrations/*.sql）', () => {
  it('至少有一个迁移文件（目录搬走时这条会红，而不是静默全绿）', () => {
    expect(files().length).toBeGreaterThan(0);
  });

  /**
   * @why 缺标记时 node-pg-migrate 会把**整个文件**当成 up，down 变成空操作 ⇒
   *      `db:migrate down` 静默什么都不做，而回滚的失败只在真要回滚那天才被发现。
   */
  it('每个文件都有 Up / Down 分段标记', () => {
    for (const f of files()) {
      const t = read(f);
      expect(t, `${f} 缺 ${UP}`).toContain(UP);
      expect(t, `${f} 缺 ${DOWN}`).toContain(DOWN);
      expect(t.indexOf(UP), `${f} 的 Up 标记必须在 Down 之前`).toBeLessThan(t.indexOf(DOWN));
    }
  });

  /**
   * 🔴 本文件的正题：up 段有破坏性语句 → 文件头必须写 `@breaking` 说明
   *    "为什么这一版可以在旧实例仍在服务时执行"。
   */
  it('up 段含破坏性语句的文件，文件头必须带 @breaking 说明（DB2-07）', () => {
    const missing: string[] = [];
    for (const f of files()) {
      const t = read(f);
      const body = upBody(t).toUpperCase();
      const hit = BREAKING.filter((k) => body.includes(k));
      if (hit.length === 0) continue;
      if (!header(t).includes('@breaking')) {
        missing.push(`${f}（${hit.join(' / ')}）`);
      }
    }
    expect(
      missing,
      `以下迁移的 up 段有破坏性语句但文件头没写 @breaking：\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * @why 反向也钉：没有破坏性语句的文件**不该**挂 `@breaking`——
   *      否则这个标记会像 `@see` 一样慢慢变成装饰（人人都有 = 没有信息量），
   *      真出事那天它也就不再会被读了。
   */
  it('没有破坏性语句的文件不该挂 @breaking（标记不许变成装饰）', () => {
    const noisy: string[] = [];
    for (const f of files()) {
      const t = read(f);
      const body = upBody(t).toUpperCase();
      const hit = BREAKING.filter((k) => body.includes(k));
      if (hit.length === 0 && header(t).includes('@breaking')) noisy.push(f);
    }
    expect(noisy).toEqual([]);
  });
});
