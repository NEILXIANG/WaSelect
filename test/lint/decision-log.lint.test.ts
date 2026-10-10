/**
 * 职责：把「自主决策必须入档」从要求变成**会红的检查**（LM 层第三项）。
 *
 * @why 用户 2026-09-23 明确要求：AI 自行拍板的取舍都要进文档记录。
 *      而这类要求的失效方式和前面几条一模一样——**不做也不会有任何东西报错**，
 *      忙起来就变成"回头补"，而"回头补"从来没有回头过。
 *      所以这里至少把"写进去了的必须写全"变成机器能验的：
 *      七项字段缺一项就红，编号重复就红，文档被清空或章节被删就红。
 *
 * @limitation 一（重要）：**它管不了"该记的有没有记"**。
 *              我无法让脚本判断"这次改动里有没有发生自主决策"——那是语义判断。
 *              所以这条门禁的真实作用是：保证**已经写进去的条目是完整的**，
 *              以及防止文档被悄悄清空/瘦身。"别忘了写"仍然依赖 CLAUDE.md 抬头那条硬要求与 review。
 * @limitation 二：只校验字段的**存在**，不校验内容质量。
 *              "- **反向风险**：无" 这种敷衍写法照样过——那是 H3 人工项的职责。
 *
 * @see ../../docs/自主决策记录.md §4（维护约定）；CLAUDE.md 抬头（自主决策必须入档）
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOC = resolve(import.meta.dirname, '../../docs/自主决策记录.md');

/** 每条决策必须写全的七项（与文档 §4 的约定一致，改这里必须同步改文档）。 */
const REQUIRED_FIELDS = ['场景', '可选', '选择', '依据', '反向风险', '回滚', '下游'] as const;

interface Entry {
  id: string;
  body: string;
}

function readDoc(): string {
  expect(existsSync(DOC), `缺少 ${DOC}`).toBe(true);
  return readFileSync(DOC, 'utf8');
}

/** 只解析 §1（决策台账），§2/§3 单独校验。 */
function entries(doc: string): Entry[] {
  const section1 = doc.split(/^## 2\./m)[0] ?? '';
  return section1
    .split(/^### /m)
    .slice(1)
    .map((block) => ({
      id: block.split('\n')[0]?.trim() ?? '',
      body: block,
    }));
}

/**
 * 全文所有 `### AJ-xx` 标题行（行号从 1 起）。
 * @why TST3-01（第三轮审查）：AJ-200～AJ-244 共 46 条被追加在 §4 之后，
 *      而 {@link entries} 只解析 §1——七项字段、依据长度、编号唯一三项检查对它们全部不执行，
 *      文件里出现了两条 `AJ-225` 门禁仍是绿的。"写错位置"必须本身就红，而不是被静默跳过。
 */
function allEntryHeadings(doc: string): { line: number; id: string }[] {
  return doc
    .split('\n')
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter((x) => /^### AJ-\d+/.test(x.text))
    .map((x) => ({ line: x.line, id: (x.text.match(/^### (AJ-\d+)/) ?? ['', ''])[1] ?? '' }));
}

describe('自主决策记录（docs/自主决策记录.md）', () => {
  it('文档存在且不是空壳（条目数有下限）', () => {
    const doc = readDoc();
    const list = entries(doc);
    // 数量下限不是精确指标，是防"文档被瘦身到只剩几条然后全绿"
    expect(list.length, '决策条目被大量删除，或解析规则失效').toBeGreaterThanOrEqual(10);
  });

  it('每条决策七项字段齐全（场景/可选/选择/依据/反向风险/回滚/下游）', () => {
    const list = entries(readDoc());
    const missing: string[] = [];
    for (const e of list) {
      for (const f of REQUIRED_FIELDS) {
        if (!e.body.includes(`- **${f}`)) missing.push(`${e.id} 缺「${f}」`);
      }
    }
    expect(missing, `字段不全：\n${missing.join('\n')}`).toEqual([]);
  });

  it('每条的「依据」不是空话（长度下限，防止写成"依据：经验"）', () => {
    const list = entries(readDoc());
    const thin: string[] = [];
    for (const e of list) {
      const line = e.body.split('\n').find((l) => l.startsWith('- **依据'));
      const text = (line ?? '').replace(/^- \*\*依据[^*]*\*\*[：:]?\s*/u, '');
      // 依据通常要跨行写，这里只看首行；首行过短基本可以判定是敷衍
      if (text.trim().length < 10) thin.push(`${e.id}：${text.trim()}`);
    }
    expect(thin, `依据写得太短，读它的人还原不出判断：\n${thin.join('\n')}`).toEqual([]);
  });

  it('编号 AJ-xx 唯一（编号不回收，重复说明有人插错了位置）', () => {
    const list = entries(readDoc());
    const ids = list.map((e) => (e.id.match(/^AJ-\d+/) ?? [''])[0] ?? '');
    expect(ids.filter((i) => i.length > 0).length, '有条目没有 AJ-xx 编号').toBe(list.length);
    // TST3-01：唯一性按**全文**算——§1 之外的重复同样是重复
    const all = allEntryHeadings(readDoc()).map((h) => h.id);
    const dup = all.filter((id, i) => all.indexOf(id) !== i);
    expect(dup, `编号重复：${dup.join('、')}`).toEqual([]);
  });

  it('所有 AJ 条目都在 §1 里（写在 §2 之后的条目不受上面任何检查，TST3-01）', () => {
    const doc = readDoc();
    const s2 = doc.split('\n').findIndex((l) => /^## 2\./.test(l)) + 1;
    const outside = allEntryHeadings(doc).filter((h) => s2 > 0 && h.line > s2);
    expect(
      outside.map((h) => `${h.id}（第 ${h.line} 行）`),
      '这些条目写在 §2 之后，七项字段 / 依据 / 编号检查都管不到它们——请移到 §1 末尾',
    ).toEqual([]);
  });

  it('「被实测推翻的判断」与「仍需人拍板」两节都在（区分"我定了"和"该你定"）', () => {
    const doc = readDoc();
    // TST3-01：标题按**行首整行**匹配。原来用 toContain 找"仍然需要人拍板"，
    // 会被 §4.1 表格里的同一串字掩盖——§3 标题改名后仍然是绿的。
    expect(doc, '§2 被删了——那是记录失败模式的一节').toMatch(/^## 2\. 被实测推翻的判断/m);
    expect(doc, '§3 被删了——会让人误以为所有事项都已由 AI 决定').toMatch(
      /^## 3\. 仍然需要人拍板的/m,
    );
  });
});

/**
 * §2「被实测推翻的判断」的条目编号（统一结论操作律 6：编号唯一性 lint）。
 * @why 别处按号引用这些条目（CLAUDE.md「§2 第 8、9 条」「第 38 条」等）；同一个号出现两次，引用就指不清是哪一条。
 * @why 历史上第 8–23 条重号了两轮（一组旧的、一组标 🆕）。**不改号**：改了会让已有的按号引用全部错位。
 *      所以冻结成名单：这 16 个号每个最多出现两次；名单外的号必须唯一。缺号（52–56）允许——编号不回收。
 * @limitation 只看表格第一列的号（去掉 🆕 和"-附"之类后缀前的数字部分作为同一号）；写在表格外的条目管不到。
 */
const SEC2_FROZEN_DUPLICATES = new Set(
  // 不能再往里加：新增条目一律用新号（当前最大号 + 1）。这 16 个是 2026-10-09 实测的全部历史重号
  Array.from({ length: 16 }, (_, i) => String(i + 8)),
);

function sec2Numbers(doc: string): string[] {
  const a = doc.search(/^## 2\. 被实测推翻的判断/m);
  const b = doc.indexOf('\n## 3.', a);
  return doc
    .slice(a, b)
    .split('\n')
    .map((line) => /^\|\s*([^|]+?)\s*\|/.exec(line)?.[1] ?? '')
    .filter((c) => c !== '' && c !== '#' && !/^[-: ]+$/.test(c))
    .map((c) => c.replace(/\s*🆕/gu, '').trim());
}

describe('§2 条目编号', () => {
  it('🔴 编号唯一（冻结的历史重号除外，且每个最多两次）', () => {
    const nums = sec2Numbers(readDoc());
    expect(nums.length).toBeGreaterThan(100);
    const count = new Map<string, number>();
    for (const n of nums) count.set(n, (count.get(n) ?? 0) + 1);
    const bad = [...count]
      .filter(([n, c]) => (SEC2_FROZEN_DUPLICATES.has(n) ? c > 2 : c > 1))
      .map(([n]) => n);
    expect(bad, `§2 编号重复：${bad.join('、')}——新条目请用当前最大号 + 1`).toEqual([]);
  });
});
