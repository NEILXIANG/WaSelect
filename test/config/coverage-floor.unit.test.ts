/**
 * 职责：`scripts/check-coverage-floor.mjs`（逐文件覆盖率底线）的单测（TST3-03）。
 * @why 这条检查本身也要"注回缺陷会红"：零覆盖文件必须被报出来，否则它就是一条永远绿的摆设。
 */
import { describe, expect, it } from 'vitest';
import { coverageFloorViolations, FLOOR } from '../../scripts/check-coverage-floor.mjs';

const m = (lines: number, branches: number, lt = 10, bt = 4) => ({
  lines: { pct: lines, total: lt },
  branches: { pct: branches, total: bt },
});

describe('coverageFloorViolations', () => {
  it('零覆盖的新文件被报出（行与分支各一条）', () => {
    const out = coverageFloorViolations(
      { total: m(90, 90), '/repo/server/src/app/new-route.ts': m(0, 0) },
      '/repo',
    );
    expect(out).toEqual([
      'server/src/app/new-route.ts：分支 0% < 50%',
      'server/src/app/new-route.ts：行 0% < 60%',
    ]);
  });

  it('恰好在底线上放行；低 0.01 报出', () => {
    const at = coverageFloorViolations({ '/r/a.ts': m(FLOOR.lines, FLOOR.branches) }, '/r');
    expect(at).toEqual([]);
    const below = coverageFloorViolations({ '/r/a.ts': m(FLOOR.lines - 0.01, 100) }, '/r');
    expect(below).toHaveLength(1);
  });

  it('没有可执行行 / 分支的文件（total=0）不报', () => {
    expect(coverageFloorViolations({ '/r/types.ts': m(0, 0, 0, 0) }, '/r')).toEqual([]);
  });

  it('豁免名单里的文件跳过；total 键跳过', () => {
    const out = coverageFloorViolations({ total: m(0, 0), '/r/x.ts': m(0, 0) }, '/r', FLOOR, {
      'x.ts': '原因',
    });
    expect(out).toEqual([]);
  });
});
