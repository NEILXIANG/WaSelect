/**
 * 职责：地址 fixture 与形态清单的**双向一致**核对（把 H2 从人工项变成门禁）。
 *
 * @why 清单写出来没人核，就等于没写：过两个月有人往 `US_ADDRESSES` 里加一条"看起来差不多"的
 *      新地址，或者"清理"掉某条觉得奇怪的军邮样本，谁都不会报错。
 *      这里用 `audit()` 把两件事钉住：清单要求的形态一条都不能少、数据里的每一条都要有归属。
 *
 * @limitation 引擎管不了"清单本身漏了维度"（见 `engine.ts` 的 @limitation 一）。
 *              所以本文件**不是**"地址数据已经合格"的证明，它只证明"清单与数据一致"。
 * @see ../catalog.ts；../addresses.db.test.ts；CLAUDE.md H2
 */
import { describe, expect, it } from 'vitest';
import {
  US_ADDRESSES,
  US_ADDRESS_INVALID,
  type AddressSeed,
  type InvalidAddressCase,
} from '../catalog.js';
import { audit, formatViolations } from './engine.js';
import { US_ADDRESS_DIRTY_SHAPES, US_ADDRESS_SHAPES } from './us-address.js';

const labelAddress = (a: AddressSeed): string =>
  `${a.recipient} / ${a.city}, ${a.state} ${a.postalCode}`;
const labelDirty = (c: InvalidAddressCase): string => c.name;

describe('地址 fixture ↔ 形态清单（双向一致）', () => {
  it('清单要求的每一种真实形态都有样本', () => {
    const vs = audit({ shapes: US_ADDRESS_SHAPES, pool: US_ADDRESSES, label: labelAddress });
    expect(vs, `形态清单与数据不一致：\n${formatViolations(vs)}`).toEqual([]);
  });

  it('数据里每一条都落在清单的某个形态上（防清单漏记 / 防数据不真实）', () => {
    // 与上面那条是**两个方向**：只查前者的话，往数据里塞一条不属于任何形态的地址也不会红
    const vs = audit({ shapes: US_ADDRESS_SHAPES, pool: US_ADDRESSES, label: labelAddress });
    const unmatched = vs.filter((v) => v.reason.includes('不属于清单'));
    expect(unmatched, `有数据不属于任何已登记形态：\n${formatViolations(unmatched)}`).toEqual([]);
  });

  it('脏输入清单与反例数据一致', () => {
    const vs = audit({
      shapes: US_ADDRESS_DIRTY_SHAPES,
      pool: US_ADDRESS_INVALID,
      label: labelDirty,
    });
    expect(vs, `脏输入清单与反例不一致：\n${formatViolations(vs)}`).toEqual([]);
  });

  /**
   * 清单本身要够厚。
   * @why 清单可以被"瘦身"到只剩几条然后全绿——那等于机制被架空了。
   *      给一个下限（正例 ≥12 条、反例 ≥5 条）不是精确指标，是"别让它退化"的护栏。
   * @limitation 数量下限是粗糙的；它管不了"清单里塞了 20 条无意义形态"。
   *              那部分只能靠 review（对应 CLAUDE.md 的 H2）。
   */
  it('清单没有退化（形态数量有下限）', () => {
    const required = US_ADDRESS_SHAPES.filter((s) => s.coverage === true).length;
    expect(required, '正例形态被删减了').toBeGreaterThanOrEqual(12);
    expect(
      US_ADDRESS_DIRTY_SHAPES.filter((s) => s.coverage === true).length,
    ).toBeGreaterThanOrEqual(5);
  });
});

describe('清单核对引擎自身（engine.ts 的红灯证据）', () => {
  /** 引擎只在这份用例里被"注回缺陷"验证——它要是坏的，上面四条断言全是假的。 */
  it('缺样本 / 无归属样本 / 空原因的 n/a 都能被查出来', () => {
    const shapes = [
      { id: 'a', why: '有样本', coverage: true as const, matches: (n: number) => n === 1 },
      { id: 'b', why: '没样本', coverage: true as const, matches: (n: number) => n === 99 },
      { id: 'c', why: '空原因', coverage: '   ' as const, matches: (_n: number) => false },
    ];
    const vs = audit({ shapes, pool: [1, 2], label: String });
    expect(vs.map((v) => v.reason)).toContain('声明了 n/a 却没写原因（不许有无原因的豁免）');
    expect(vs.some((v) => v.shapeId === 'b')).toBe(true);
    expect(vs.some((v) => v.reason.includes('不属于清单'))).toBe(true);
  });

  it('重复的形态代号会被查出来', () => {
    const shapes = [
      { id: 'dup', why: '', coverage: true as const, matches: (_n: number) => true },
      { id: 'dup', why: '', coverage: true as const, matches: (_n: number) => true },
    ];
    const vs = audit({ shapes, pool: [1], label: String });
    expect(vs.map((v) => v.reason)).toContain('形态代号重复');
  });

  it('标了 n/a 却真有样本命中 → 判为矛盾', () => {
    const shapes = [
      { id: 'na', why: '', coverage: 'XX 不适用' as const, matches: (_n: number) => true },
    ];
    const vs = audit({ shapes, pool: [1], label: String });
    expect(vs.some((v) => v.reason.includes('清单与实际矛盾'))).toBe(true);
  });
});
