/**
 * 职责：进度表"状态必须带证据"的最小门禁（N35 ④ 采纳）。
 *
 * @why 进度表是给"现在到底做到哪了"的唯一答案。一个不带证据的 ✅ 比 ⬜ 更糟——
 *      ⬜ 至少诚实，空口 ✅ 会让后续所有排期建立在不存在的地基上。
 *      这类失真是**文本层**问题，单测/构建都管不到，只能靠结构断言每跑必查。
 *
 * 规则（与《地基搭建清单》§6.0 状态口径同步，改一边必须改另一边）：
 * - ✅ / 🟡 行的「落点」列必须非空（写文件/用例数/决策号都算证据）；
 * - ⬜ 行允许为空（没动就是没有证据）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const doc = readFileSync(join(__dirname, '..', '..', 'docs', '地基搭建清单.md'), 'utf8');

/** 抽出 §6.0 进度表的全部数据行：| F编号 | 项 | 状态 | 落点 | */
function progressRows(): Array<{ id: string; status: string; evidence: string }> {
  const section = doc.split('### 6.0 进度')[1];
  if (section === undefined) throw new Error('找不到 §6.0 进度小节——标题被改动了？');
  const rows: Array<{ id: string; status: string; evidence: string }> = [];
  for (const line of section.split('\n')) {
    const m = /^\|\s*(F\w+)\s*\|[^|]*\|\s*(✅|🟡|⬜)\s*\|([^|]*)\|/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      rows.push({ id: m[1], status: m[2], evidence: m[3].trim() });
    }
  }
  return rows;
}

describe('进度表状态必须带证据（N35 ④）', () => {
  it('扫描确实命中了进度表（防空扫描假绿：表结构变了必须红）', () => {
    expect(progressRows().length).toBeGreaterThanOrEqual(15); // F0–F17 含 F2b/F6b/F6c
  });

  it('✅ / 🟡 行的「落点」列必须非空', () => {
    const violations = progressRows().filter(
      (r) => (r.status === '✅' || r.status === '🟡') && r.evidence.length === 0,
    );
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
