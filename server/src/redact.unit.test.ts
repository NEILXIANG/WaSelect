/**
 * 职责：脱敏的 L0 单测 + 属性测试（F5）。
 * 脱敏是安全红线，这里刻意测"漏了会怎样"而不是"成功了怎样"：每条断言都是"原值不得出现在输出里"。
 * @see docs/代码注释规范与日志体系设计.md（脱敏红线）；docs/地基搭建清单.md F5
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { maskText, redact } from './redact.js';

describe('键名脱敏（主要手段）', () => {
  it('敏感键名的值被掩码，非敏感键名原样保留', () => {
    const out = redact({
      stripe_secret_key: 'sk_live_abc123',
      authorization: 'Bearer xyz',
      order_id: 'W20260922-000001',
      amount_jpy: 12800,
    }) as Record<string, unknown>;
    expect(out.stripe_secret_key).not.toBe('sk_live_abc123');
    expect(out.authorization).toBe('***');
    expect(out.order_id).toBe('W20260922-000001');
    expect(out.amount_jpy).toBe(12800);
  });

  it('电话 / 邮箱 / openid 保留可关联片段，但不保留完整值', () => {
    const out = redact({
      phone: '09012345678',
      email: 'hanako@example.com',
      openid: 'oABCdefGHIjklMNOPqrstUVWXYZ0123',
    }) as Record<string, unknown>;
    expect(out.phone).toBe('***5678');
    expect(out.email).toBe('h***@example.com');
    expect(String(out.openid)).not.toContain('ABCdefGHIjklMNOPqrstUVWXYZ');
  });

  it('空字符串不产生 `***`（空值掩码会误导排查）', () => {
    const out = redact({ token: '' }) as Record<string, unknown>;
    expect(out.token).toBe('');
  });
});

describe('文本兜底正则', () => {
  it('自由文本里的卡号只留后 4 位', () => {
    expect(maskText('card 4242424242424242 used')).toContain('***4242');
    expect(maskText('card 4242424242424242 used')).not.toContain('4242424242424242');
  });

  it('自由文本里的邮箱保留域名、隐去主体', () => {
    const masked = maskText('notify hanako@example.com now');
    expect(masked).not.toContain('hanako@');
    expect(masked).toContain('example.com');
  });

  it('国际电话被掩码', () => {
    expect(maskText('tel +81 90-1234-5678')).not.toContain('1234-5678');
  });

  it('普通业务文本不被误伤（过度脱敏会让日志失去可定位性）', () => {
    expect(maskText('order created')).toBe('order created');
    expect(maskText('W20260922-000001')).toBe('W20260922-000001');
    expect(maskText('amount=12800 JPY')).toBe('amount=12800 JPY');
  });

  it('属性：掩码后的文本一定不含原始邮箱主体（500 样本）', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 30 }),
        fc.emailAddress(),
        (prefix, email) => {
          const text = `${prefix} ${email} tail`;
          const masked = maskText(text);
          const local = email.slice(0, email.indexOf('@'));
          if (local.length > 1) expect(masked).not.toContain(`${local}@`);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('结构安全（日志进程不能被日志本身搞死）', () => {
  it('循环引用不栈溢出', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect(JSON.stringify(redact(a))).toContain('Circular');
  });

  it('超深嵌套被截断', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('Deep');
  });

  it('Error 被摊平成可检索字段，而不是变成空对象', () => {
    const out = redact({ err: new Error('connection refused') }) as Record<string, unknown>;
    expect(out.err).toMatchObject({ err_type: 'Error', err_message: 'connection refused' });
  });

  it('不修改入参（脱敏不能把运行中的对象也抹掉）', () => {
    const input = { password: 'p@ss', note: 'keep' };
    redact(input);
    expect(input.password).toBe('p@ss');
    expect(input.note).toBe('keep');
  });

  it('幂等：脱敏两次结果相同（日志重复处理不会越抹越乱）', () => {
    const once = redact({ token: 'abcdef', email: 'x@y.com', n: 1 });
    expect(redact(once)).toEqual(once);
  });
});
