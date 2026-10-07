/**
 * 职责：README「口径对账」段 ↔ 代码真值的**三项对账**（AJ-377）。
 *
 * @why README 第 9 行那段是别人（和下一轮的我）了解这个仓库的第一入口，
 *      它同时写死了三个**极易过期又极容易被当成事实**的数字：小程序页面数、
 *      业务表数、迁移编号区间。它们过期时不会报错、不会有任何测试变红，
 *      只会让读它的人**照着一份过期的清单去做一件已经做完的事**。
 *      @measured（本轮实证）：按「`app.json` 注册 13 页 ……（提审前应移除后两者的登记）」
 *      去排"移除两个演示页登记"，结果那件事 **AJ-180 早已完成**（登记已移除、
 *      `project.config.json` 按目录排除、还有专门用例钉住）——白跑一趟，
 *      而真正的剩余工作（A2 / A3）被这趟岔开。
 *
 * @why 用**解析 README + 比对真值**而不是"提醒人记得改"：
 *      本项目在别处已经确立了同一条纪律——写数字的地方必须能红
 *      （`db.db.test.ts` 的表清单断言、`render-env.unit.test.ts` 的键名对账、
 *      `wechat-domains.unit.test.ts` 的域名对账）。README 是唯一一个
 *      "写了数字却没人管"的角落，本文件把这个洞补上。
 *
 * @limitation 只比对**对账段里写明的那三个数字**，不做全文数字扫描
 *      （全文扫描会把"13 表 / 17 张是旧基准"这类**刻意引用旧值**的说明也判成漂移，
 *      误红会让人开始怀疑整段）。所以 README 必须把要守的数字放进对账段——
 *      这正是"口径对账"这个标记存在的意义。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

/**
 * 从 README 的对账段里取一个数字。
 * @why 找不到就**抛**而不是返回 0：返回 0 会让下面每条断言都因为"两边都是 0"而绿，
 *      那是本项目反复出现过的"空对空"假绿灯（@see render-env.unit.test.ts 的锚点断言）。
 */
function readmeNum(label: string, re: RegExp): number {
  const m = re.exec(readme);
  if (m === null) {
    throw new Error(
      `README 的对账段里找不到「${label}」——段落被改写或标记被删了。` +
        `若是刻意改口径，请同时改本文件的正则（对账段的形态由本文件与 README 共同定义）`,
    );
  }
  return Number(m[1]);
}

/** 迁移文件名前缀的编号（`001_init.sql` → 1）。 */
function migrationNumbers(): number[] {
  return readdirSync(join(ROOT, 'migrations'))
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .map((f) => Number(f.slice(0, 3)));
}

describe('README 口径对账（AJ-377：文档里的数字必须接回真源）', () => {
  /**
   * @why 先钉住"对账段存在且三个数字都在"——少了这一步，下面三条在段落被删时全部跳过，
   *      整套守卫静默消失（与"解析器坏了 → 全绿"同一形态）。
   */
  it('对账段三个数字都解析得到（防"段落被删 → 下面全部跳过"）', () => {
    expect(readme).toContain('口径对账');
    expect(readmeNum('小程序页面', /小程序页面 \*\*(\d+)\*\* 页/)).toBeGreaterThan(0);
    expect(readmeNum('业务表', /业务表 \*\*(\d+)\*\* 张/)).toBeGreaterThan(0);
    expect(readmeNum('迁移', /迁移 \*\*(\d{3})–(\d{3})\*\*/)).toBeGreaterThan(0);
  });

  it('🔴 小程序页面数 == app.json 实际登记的页数（加页忘改 README → 红）', () => {
    const appJson = JSON.parse(readFileSync(join(ROOT, 'miniprogram/app.json'), 'utf8')) as {
      pages: string[];
    };
    expect(appJson.pages.length, 'app.json 解析不出 pages（文件换了结构？）').toBeGreaterThan(0);
    expect(readmeNum('小程序页面', /小程序页面 \*\*(\d+)\*\* 页/)).toBe(appJson.pages.length);
  });

  it('🔴 业务表数 == db.db.test.ts 表清单断言的那个数（加表忘改 README → 红）', () => {
    // ⚠️ 真值是**那条断言**，不是重新数一遍库：数库要起 DB（db 层），而这里要的是
    //    "README 与唯一真源一致"——真源的定义就是那条断言（README 自己也是这么写的）。
    const src = readFileSync(join(ROOT, 'server/src/adapters/db.db.test.ts'), 'utf8');
    const m = /expect\(tables\)\.toHaveLength\((\d+)\)/.exec(src);
    expect(
      m,
      'db.db.test.ts 里找不到 `expect(tables).toHaveLength(N)`——真源换了写法',
    ).not.toBeNull();
    expect(readmeNum('业务表', /业务表 \*\*(\d+)\*\* 张/)).toBe(Number(m?.[1]));
  });

  it('🔴 迁移区间 == migrations/ 实际的首号与末号，且编号连续无缺号', () => {
    const nums = migrationNumbers().sort((a, b) => a - b);
    expect(nums.length, 'migrations/ 里没有符合 NNN_*.sql 的文件').toBeGreaterThan(0);
    const m = /迁移 \*\*(\d{3})–(\d{3})\*\*/.exec(readme);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(nums[0]);
    expect(Number(m?.[2])).toBe(nums[nums.length - 1]);
    // 连续：缺号会让"末号"看起来对但迁移跑不全（pgmigrations 按序应用）
    for (let i = 1; i < nums.length; i += 1) {
      expect(nums[i], `迁移编号不连续：${nums[i - 1]} 之后是 ${nums[i]}`).toBe(
        (nums[i - 1] as number) + 1,
      );
    }
  });

  it('README 不得再写"提审前应移除两个演示页登记"（AJ-180 已完成，留着会让人白跑一趟）', () => {
    expect(readme).not.toContain('提审前应移除后两者的登记');
  });
});
