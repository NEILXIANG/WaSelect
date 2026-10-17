/**
 * 职责：自研变异测试的单测——算子生成、跳过规则、编排的"必还原"、报告与阈值判定。
 */
import { describe, expect, it } from 'vitest';
import {
  generateMutants,
  renderReport,
  runMutation,
  summarize,
  type MutationDeps,
} from './mutate-lib.js';

const SRC = [
  "import { x } from './x.js';",
  '// if (a === b) 注释里的不算',
  'export function f(a: number, b: number): boolean {',
  '  if (a <= b && b > 0) return true;',
  '  if (!ok(a)) return false;',
  '  return a === b;',
  '}',
].join('\n');

describe('generateMutants', () => {
  it('🔴 每个变异只改一处；注释与 import 行不动；算子覆盖比较 / 逻辑 / 布尔 / 取反', () => {
    const ms = generateMutants(SRC);
    expect(ms.map((m) => `${String(m.line)}:${m.operator}`)).toEqual([
      '4:<= → <',
      '4:> → >=',
      '4:&& → ||',
      '4:true → false',
      '5:false → true',
      '5:去掉取反 !',
      '6:=== → !==',
    ]);
    for (const m of ms) {
      const diff = m.source.split('\n').filter((l, i) => l !== SRC.split('\n')[i]);
      expect(diff, `${m.operator} 应只改一行`).toHaveLength(1);
    }
    expect(ms.find((m) => m.operator === '去掉取反 !')?.source).toContain(
      '  if (ok(a)) return false;',
    );
  });

  it('`=>` 与 `<=` 的一部分不被当成 `>` / `<`（prettier 口径：运算符两侧有空格才算）', () => {
    const ms = generateMutants('const g = (a: number) => a<b;');
    expect(ms).toEqual([]);
  });
});

describe('runMutation', () => {
  function deps(fail: (file: string, content: string) => boolean) {
    const disk = new Map<string, string>([['a.ts', SRC]]);
    const writes: string[] = [];
    let t = 0;
    const d: MutationDeps = {
      readFile: (p) => disk.get(p) ?? '',
      writeFile: (p, c) => {
        disk.set(p, c);
        writes.push(c === SRC ? 'restore' : 'mutate');
      },
      runTests: (file) => !fail(file, disk.get(file) ?? ''),
      now: () => (t += 10),
      log: () => undefined,
    };
    return { d, disk, writes };
  }

  it('🔴 跑完后文件必须还原为原文；测试红 = killed，绿 = survived', async () => {
    const { d, disk, writes } = deps((_f, content) => content.includes(' || ')); // 只有 && → || 这一个会被"抓住"
    const rs = await runMutation(d, ['a.ts']);
    expect(disk.get('a.ts')).toBe(SRC);
    expect(writes.at(-1)).toBe('restore');
    expect(rs.filter((r) => r.status === 'killed').map((r) => r.operator)).toEqual(['&& → ||']);
    expect(summarize(rs)).toMatchObject({ total: 7, killed: 1, score: 14.3 });
  });

  it('🔴 跑测试中途抛错也还原（finally）', async () => {
    const { d, disk } = deps(() => {
      throw new Error('vitest 崩了');
    });
    await expect(runMutation(d, ['a.ts'])).rejects.toThrow('vitest 崩了');
    expect(disk.get('a.ts')).toBe(SRC);
  });
});

describe('renderReport', () => {
  const rs = [
    { file: 'a.ts', line: 4, operator: '&& → ||', status: 'killed' as const, ms: 10 },
    { file: 'a.ts', line: 5, operator: '=== → !==', status: 'survived' as const, ms: 10 },
  ];
  it('列出存活清单；低于阈值尾行 FAILED，未设阈值只出报告', () => {
    const bad = renderReport(rs, { startedAt: 't', breakBelow: 60 });
    expect(bad).toContain('- a.ts:5 === → !==');
    expect(bad.split('\n').at(-1)).toBe('mutation FAILED: score 50% < 60%');
    expect(renderReport(rs, { startedAt: 't', breakBelow: null }).split('\n').at(-1)).toBe(
      'mutation ok: score 50%（未设阈值，只出报告）',
    );
    expect(renderReport(rs, { startedAt: 't', breakBelow: 40 }).split('\n').at(-1)).toBe(
      'mutation ok: score 50% ≥ 40%',
    );
  });
});
