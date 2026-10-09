/**
 * 职责：**统一 Toast 的收敛门禁**（第一批①）——把"还有哪些页面没接线"钉成机器可查的事实。
 *
 * @why 附件 §5 给的结论是"统一 Toast 组件，所有写操作走它"。这句话最容易的失效方式不是做错，
 *      而是**做了一半就以为做完了**：新页面照旧写一份 `<p className="error">`，
 *      没有人会回头去改；而"我们统一了"这句话在文档里永远是真的（§2 第 88 条：
 *      文档里"待办 / 当前 N 处"这类手写文字，写完没人回头删）。
 *      所以这里改成**双向钉子**：
 *        - 清单**外**的文件不许再写行内反馈 → 新增页面只能走 Toast；
 *        - 清单**内**的文件必须**真的还有** → 谁迁完一页就必须把它从清单里删掉，
 *          否则这条会红（清单自己不会撒谎说"还欠着"）。
 *
 * @why 只盯"页面级反馈"，不盯字段级行内校验：
 *      附件 §5 把"行内校验"列为**通行做法**（错误要显示在出错的那个字段旁边），
 *      把校验错误也搬进 Toast 反而更难用。本门禁管的是"这次操作成了没成"那一层。
 *
 * @limitation 扫描是**正则**级的：它能抓住既有句式，抓不住新造的等价写法
 *             （比如把文案塞进一个自定义组件）。它的价值是拦住"顺手照抄旧页面"这一大类，
 *             不是证明"全站已统一"。
 *
 * @see ./toast.tsx；../../docs/管理后台对标分析-成熟电商平台-2026-10-08.md §8-1①
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');

/** 页面级反馈的两种句式（成功提示 + 条件渲染的错误提示）。 */
const PATTERNS = [/<p className="ok"/, /\{[A-Za-z_][A-Za-z0-9_]* !== '' && <p className="error">/];

/** 剥掉块注释与行注释（注释里举的反例不能把自己扫成违规，AJ-74 同款教训）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** 递归列出待扫的 .tsx（`ui/` 是组件自身、`testing/` 是测试宿主，都豁免）。 */
function listPageTsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'ui' && e.name !== 'testing') listPageTsx(full, out);
    } else if (e.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const REL = (f: string): string => f.slice(SRC.length + 1);
const hasInline = (f: string): boolean => {
  const body = stripComments(readFileSync(f, 'utf8'));
  return PATTERNS.some((p) => p.test(body));
};

/**
 * 仍写着行内反馈句式的页面（第一批① 的**欠账清单**；审查 2026-10-09 起其余页面已全部迁完）。
 *
 * 迁移一页 → 从这张表里删一行 → 本文件第二条用例会逼你删（否则它报"清单过期"）。
 * ⚠️ 删之前请确认那一页的反馈**真的**改走 `useToasts()` 了，不要为了让这条变绿而删。
 * ⚠️ 留在表里的每一行都必须在 `why` 里写明**为什么不迁**（刻意保留的行内闸门说明也算，没有原因的豁免会让机制失效）。
 */
const PENDING: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'orders/PartialRefunds.tsx',
    why:
      '不是欠账、是刻意保留：提交的成败已全部经 onError / onNotice / onSuccess 走父页 Toast；' +
      '剩下的 `hint` 是金额 / 原因的表单闸门说明（超额度、未选原因），必须紧挨金额框、改了就清（N30），' +
      '其 DOM 用例断言的正是行内 `p.error`（缺陷注入验证过）',
  },
];

const pendingFiles = new Set(PENDING.map((p) => p.file));

describe('扫描器自检（空扫描会让下面两条都变成假绿灯，§2 第 34 条）', () => {
  it('脏样本全报 / 干净样本不报 / 注释里的反例不报', () => {
    const dirty = '{error !== \'\' && <p className="error">{error}</p>}\n<p className="ok">ok</p>';
    expect(PATTERNS.some((p) => p.test(stripComments(dirty)))).toBe(true);
    // 干净样本：字段级行内校验**不该**被本门禁抓（附件 §5：错误要显示在出错的字段旁边）
    const clean = '{errors[\'qty\'] !== undefined && <span className="error">x</span>}';
    expect(PATTERNS.some((p) => p.test(stripComments(clean)))).toBe(false);
    // 反例写在注释里不算违规
    const commented = `/* 反例：{error !== '' && <p className="error"> */}\n<div/>`;
    expect(PATTERNS.some((p) => p.test(stripComments(commented)))).toBe(false);
  });

  it('至少扫到一个 .tsx（目录搬走了会静默空转）', () => {
    expect(listPageTsx(SRC).length).toBeGreaterThan(0);
  });
});

describe('统一 Toast 的收敛（第一批①）', () => {
  it('已接线：ui/ 之外的页面里，订单详情与风控三处不再有页面级反馈', () => {
    for (const f of ['orders/OrderDetail.tsx', 'risk/RiskPage.tsx', 'risk/BlockedUsers.tsx']) {
      expect(hasInline(join(SRC, f)), `${f} 还在写页面级反馈——接线没做完`).toBe(false);
    }
  });

  it('清单外的页面不得再写行内反馈（新增页面只能走 Toast）', () => {
    const offenders = listPageTsx(SRC)
      .filter((f) => !pendingFiles.has(REL(f)) && hasInline(f))
      .map((f) => REL(f));
    expect(
      offenders,
      `这些页面写了行内反馈却不在欠账清单里：\n${offenders.join('\n')}\n` +
        `→ 要么改走 useToasts()，要么把它加进 PENDING 并写明为什么这一页暂不改。`,
    ).toEqual([]);
  });

  it('🔴 清单里的文件必须**真的还有**行内反馈（迁移完一页就必须删掉这一行）', () => {
    const stale = PENDING.filter((p) => !hasInline(join(SRC, p.file))).map((p) => p.file);
    expect(
      stale,
      `这些页面已经没有行内反馈了，请从 PENDING 里删掉（清单过期 = 它说的欠账是假的）：\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});
