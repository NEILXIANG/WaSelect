/**
 * 职责：`jstDateTime`（UTC → JST 纯函数）的单测。
 *
 * @why 它是**纯整数历日运算**，错一个边界就错一整天，而它不会报错——
 *      时间线上"建单时间晚了一天"没有任何异常可看。
 *      所以跨年 / 跨月 / 闰日 / 跨午夜这几个边界必须逐条钉住。
 * @measured 期望值双路独立验证：① BSD date 走 epoch 换算（`TZ=UTC date -j -f … +%s`
 *      得 epoch → `TZ=Asia/Tokyo date -r <epoch>` 换算）；② Python `datetime + timedelta(hours=9)`。
 *      8 组全一致。⚠️ 不能写 `TZ=Asia/Tokyo date -j -f "…" "$t"`——`-j -f` 会把输入
 *      当 TZ 本地时间解析，输出 = 输入，是恒等映射，什么都没验到（§2 第 9 条）。
 */
import { describe, expect, it } from 'vitest';
import { jstDateTime } from './jst-text.js';

describe('jstDateTime（UTC → JST）', () => {
  it('基本转换：2026-09-27T15:04:26.000Z → 2026-09-28 00:04', () => {
    // 15:04 UTC + 9h = 次日 00:04 JST
    expect(jstDateTime('2026-09-27T15:04:26.000Z')).toBe('2026-09-28 00:04');
  });

  it('同一天不跨日：2026-09-27T02:00:00Z → 2026-09-27 11:00', () => {
    expect(jstDateTime('2026-09-27T02:00:00Z')).toBe('2026-09-27 11:00');
  });

  it('跨午夜：2026-09-27T16:00:00Z → 2026-09-28 01:00（+9h 过零点）', () => {
    expect(jstDateTime('2026-09-27T16:00:00Z')).toBe('2026-09-28 01:00');
  });

  it('⚠️ 跨月：2026-01-31T20:00:00Z → 2026-02-01 05:00', () => {
    expect(jstDateTime('2026-01-31T20:00:00Z')).toBe('2026-02-01 05:00');
  });

  it('⚠️ 跨年：2026-12-31T20:00:00Z → 2027-01-01 05:00', () => {
    expect(jstDateTime('2026-12-31T20:00:00Z')).toBe('2027-01-01 05:00');
  });

  it('⚠️ 闰日：2024-02-29T20:00:00Z → 2024-03-01 05:00（闰年 2 月有 29 日）', () => {
    expect(jstDateTime('2024-02-29T20:00:00Z')).toBe('2024-03-01 05:00');
  });

  it('⚠️ 非闰年 2 月 28 日跨日：2026-02-28T20:00:00Z → 2026-03-01 05:00', () => {
    expect(jstDateTime('2026-02-28T20:00:00Z')).toBe('2026-03-01 05:00');
  });

  it('毫秒与不带秒都接（服务端 toISOString 带毫秒，手写测试可能不带）', () => {
    expect(jstDateTime('2026-09-27T00:00:00.000Z')).toBe('2026-09-27 09:00');
    expect(jstDateTime('2026-09-27T00:00:00Z')).toBe('2026-09-27 09:00');
    expect(jstDateTime('2026-09-27T00:00Z')).toBe('2026-09-27 09:00');
  });

  it('⚠️ 带显式偏移 → null（把 +09:00 的串再 +9 是静默错 9 小时，宁可不转）', () => {
    expect(jstDateTime('2026-09-27T15:04:26+09:00')).toBeNull();
    expect(jstDateTime('2026-09-27T15:04:26-05:00')).toBeNull();
  });

  it('脏输入 → null（null / 数字 / 空串 / 半截串 / 非字符串）', () => {
    expect(jstDateTime(null)).toBeNull();
    expect(jstDateTime(undefined)).toBeNull();
    expect(jstDateTime(1690000000000)).toBeNull();
    expect(jstDateTime('')).toBeNull();
    expect(jstDateTime('2026-09-27')).toBeNull();
    expect(jstDateTime('not a date')).toBeNull();
  });

  it('越界分量 → null（13 月 / 25 点 / 61 分：算法会顺势滚，语义上那是错的）', () => {
    expect(jstDateTime('2026-13-01T00:00:00Z')).toBeNull();
    expect(jstDateTime('2026-09-27T25:00:00Z')).toBeNull();
    expect(jstDateTime('2026-09-27T00:61:00Z')).toBeNull();
  });
});
