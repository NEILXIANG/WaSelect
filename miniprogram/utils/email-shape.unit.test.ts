/**
 * 职责：小程序 `utils/email-shape.js` 与共享判据（packages/shared email-shape.ts）**同一张判例表**比对（MP-9，AJ-479）。
 * @why 小程序进不了 shared（nodeModules 未开，同 cart-store MAX_LINE_QTY 的做法），只能镜像一份；
 *      两份判据漂移的表现是"前端说对、提交被拒"或反过来，这里让任何一边改了另一边红。
 */
import { describe, expect, it } from 'vitest';
import { isContactEmailShape as sharedShape } from '@waselect/shared';
import { EMAIL_SHAPE_CASES } from '../../packages/shared/src/email-shape.cases.js';
import { CONTACT_EMAIL_MAX_LENGTH, emailTypoHint, isContactEmailShape } from './email-shape.js';

describe('小程序邮箱判据 = 服务端判据（MP-9）', () => {
  it.each(EMAIL_SHAPE_CASES)('%j → %s（%s）', (v, ok) => {
    expect(isContactEmailShape(v)).toBe(ok);
    expect(sharedShape(v)).toBe(ok);
  });

  it('长度上限同值', () => {
    expect(CONTACT_EMAIL_MAX_LENGTH).toBe(255);
  });
});

describe('emailTypoHint（常见拼错提示，不拦）', () => {
  it('🔴 常见域名拼错 → 给出改正后的完整地址', () => {
    expect(emailTypoHint('jane@gmial.com')).toContain('jane@gmail.com');
    expect(emailTypoHint('jane@gmail.con')).toContain('jane@gmail.com');
    expect(emailTypoHint('jane@GMAIL.CON')).toContain('jane@gmail.com');
    expect(emailTypoHint('a@qq.con')).toContain('a@qq.com');
    expect(emailTypoHint('a@hotmial.com')).toContain('a@hotmail.com');
    expect(emailTypoHint('a@163.con')).toContain('a@163.com');
    expect(emailTypoHint('a@shop.example.con')).toContain('a@shop.example.com');
  });

  it('正确的、或认不出的 → 空串（不瞎猜：.co / .co.jp 都是真实后缀）', () => {
    for (const v of ['jane@gmail.com', 'a@yahoo.co.jp', 'a@company.co', '', 'x', 'a@b', null]) {
      expect(emailTypoHint(v), String(v)).toBe('');
    }
  });
});
