/**
 * 职责：`isContactEmailShape` 的单测（MP-9，AJ-479；严格档：对外契约的入口校验）。
 * @why 邮件是付款 / 发货 / 退款通知的唯一渠道（AJ-369），原判据只要求"有 @、无空白"——`a@b`、`x@b..com` 都放行，
 *      填错的买家完全收不到通知。判例表在 email-shape.cases.ts（小程序镜像跑同一张）。
 */
import { describe, expect, it } from 'vitest';
import { CONTACT_EMAIL_MAX_LENGTH, isContactEmailShape } from './email-shape.js';
import { EMAIL_SHAPE_CASES } from './email-shape.cases.js';

describe('isContactEmailShape（联系邮箱形状，MP-9）', () => {
  it.each(EMAIL_SHAPE_CASES)('%j → %s（%s）', (v, ok) => {
    expect(isContactEmailShape(v)).toBe(ok);
  });

  it('长度上限 = 列宽 255：恰好 255 放行，256 拒', () => {
    expect(CONTACT_EMAIL_MAX_LENGTH).toBe(255);
    const at255 = `${'a'.repeat(255 - '@x.com'.length)}@x.com`;
    expect(at255).toHaveLength(255);
    expect(isContactEmailShape(at255)).toBe(true);
    expect(isContactEmailShape(`a${at255}`)).toBe(false);
  });

  it('非字符串 → false（不抛）', () => {
    for (const v of [undefined, null, 42, {}, ['a@b.com']])
      expect(isContactEmailShape(v)).toBe(false);
  });
});
