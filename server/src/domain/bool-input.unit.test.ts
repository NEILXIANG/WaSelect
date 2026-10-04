/**
 * 职责：`optionalBool`（可选布尔判定）的行为钉子（AJ-353）。
 *
 * @why 它是 `shipping-rates-input` 与 `banner-input` **共用**的那一个判定，
 *      所以用例直接打在它身上：两处调用点各自的用例只能证明"这条链路接上了"，
 *      证明不了"这个判定本身是对的"——而两份实现漂移正是要防的事（ADR-29）。
 *
 * @why 三条边界（没传 / null / 非布尔）**各自一条**：它们走的不是同一条分支，
 *      合在一起断言时"改掉其中一条"会被另外两条兜住（覆盖假象）。
 */
import { describe, expect, it } from 'vitest';
import { optionalBool } from './bool-input.js';

/** 抛错的那一半（调用方的错误码与 details 由调用方决定，这里只验 reason）。 */
function reasonOf(raw: unknown, fallback: boolean): string {
  try {
    optionalBool(raw, 'active', fallback, (reason) => {
      throw new Error(reason);
    });
  } catch (e) {
    return e instanceof Error ? e.message : '';
  }
  return ''; // 没抛
}

describe('optionalBool', () => {
  it('布尔原样带出（true / false 都要能表达，"停用"是合法操作）', () => {
    expect(optionalBool(true, 'active', true, () => undefined as never)).toBe(true);
    expect(optionalBool(false, 'active', true, () => undefined as never)).toBe(false);
    // fallback 是 false 时显式 true 仍要是 true（缺省值不能反过来吃掉显式值）
    expect(optionalBool(true, 'active', false, () => undefined as never)).toBe(true);
  });

  it('没传（undefined）→ 取缺省', () => {
    expect(optionalBool(undefined, 'active', true, () => undefined as never)).toBe(true);
    expect(optionalBool(undefined, 'active', false, () => undefined as never)).toBe(false);
  });

  it('null 与"没传"同义 → 取缺省（前端清空表单项置 null 是合法动作）', () => {
    expect(optionalBool(null, 'active', true, () => undefined as never)).toBe(true);
    expect(reasonOf(null, true)).toBe('');
  });

  /**
   * 🔴 最关键的一条：字符串 "false" 必须响，不能落回缺省。
   * @why 它是本函数存在的全部理由——CSV / Excel 导入时列型由工具决定，
   *      字符串 "false" 是最容易出现的形态，而它表达的意图是"**我要停用**"。
   */
  it('🔴 字符串 "false" → 报 active_invalid，不落回缺省', () => {
    expect(reasonOf('false', true)).toBe('active_invalid');
    expect(reasonOf('true', true)).toBe('active_invalid');
    expect(reasonOf('', true)).toBe('active_invalid');
  });

  it('数字 0 / 1 与对象 → 同样报 invalid（JS 里 `0 !== false` 为真，旧写法正是栽在这）', () => {
    expect(reasonOf(0, true)).toBe('active_invalid');
    expect(reasonOf(1, true)).toBe('active_invalid');
    expect(reasonOf({}, true)).toBe('active_invalid');
    expect(reasonOf([], true)).toBe('active_invalid');
  });

  it('reason 用的字段名是调用方给的（换字段就换 reason，不写死 active）', () => {
    expect(reasonOf('no', false)).toBe('active_invalid');
    try {
      optionalBool('no', 'enabled', true, (reason) => {
        throw new Error(reason);
      });
    } catch (e) {
      expect(e instanceof Error ? e.message : '').toBe('enabled_invalid');
    }
  });
});
