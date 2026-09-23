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
        // ⚠️ 必须排除本地部分含 `*` 的邮箱：掩码本身就是 `****`，
        //    若原主体是 `**`，则 `**@` 作为子串必然仍出现在 `****@` 里——
        //    不变式被"掩码字符与输入字符同字母表"破坏，不是脱敏失效。
        //    （实测命中：local='**' 时 masked='****@a.aa' 含 '**@'，偶发假红灯。）
        fc.emailAddress().filter((e) => !e.slice(0, e.indexOf('@')).includes('*')),
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

/**
 * D10：键名匹配必须**整词**，不能子串。
 * @why `company` 含 `pan`、`hotel_name` 含 `tel`、`discard_reason` 含 `card`——
 *      子串匹配会把这些业务字段全打码，日志里再也查不到"哪家公司、为什么废弃"，
 *      而它们根本不是敏感信息。过度脱敏和漏脱敏一样是事故：前者天天发生且无人察觉。
 */
describe('键名整词匹配（D10）', () => {
  it('业务字段不被敏感词的子串误伤', () => {
    const out = redact({
      company: 'WaSelect',
      japan_post_no: '1234567',
      hotel_name: 'Tokyo Inn',
      panel: 'admin',
      discard_reason: 'damaged in transit',
      telemetry: { duration_ms: 12 },
    }) as Record<string, unknown>;
    expect(out.company).toBe('WaSelect');
    expect(out.japan_post_no).toBe('1234567');
    expect(out.hotel_name).toBe('Tokyo Inn');
    expect(out.panel).toBe('admin');
    expect(out.discard_reason).toBe('damaged in transit');
    expect(out.telemetry).toEqual({ duration_ms: 12 });
  });

  it('真敏感键名仍然认得（下划线 / 驼峰 / 连字符三种写法）', () => {
    const out = redact({
      api_key: 'sk_live_1',
      apiKey: 'sk_live_2',
      'api-key': 'sk_live_3',
      card_no: '4242424242424242',
      cardNumber: '4242424242424242',
      userEmail: 'hanako@example.com',
      accessKey: 'AKIA1',
      privateKey: 'pk1',
      sessionKey: 'sess1',
    }) as Record<string, unknown>;
    for (const k of [
      'api_key',
      'apiKey',
      'api-key',
      'card_no',
      'cardNumber',
      'userEmail',
      'accessKey',
      'privateKey',
      'sessionKey',
    ]) {
      expect(String(out[k]), `key=${k}`).not.toMatch(
        /sk_live_[123]|4242424242424242|hanako@|AKIA1|^pk1$|^sess1$/,
      );
    }
  });

  it('idempotency_key 不被打码——它是排查重复下单的唯一线索', () => {
    const out = redact({ idempotency_key: 'mpord-ABCDEF012345' }) as Record<string, unknown>;
    expect(out.idempotency_key).toBe('mpord-ABCDEF012345');
  });
});

/**
 * D11：自由文本正则不能误伤条码 / 时间戳 / 内部 ID。
 * @why 这三类都是"长得像卡号"的合法业务值。JAN 条码是本项目商品的唯一标识，
 *      被打码后日志里只剩 `***7894`，排查"哪个商品算错了价"直接失去线索。
 */
describe('文本正则精准度（D11）', () => {
  it('JAN-13 条码原样保留（日本商品条码，45x / 49x 开头）', () => {
    expect(maskText('jan=4901234567894')).toContain('4901234567894');
    expect(maskText('jan=4569951116179')).toContain('4569951116179');
  });

  it('毫秒时间戳原样保留', () => {
    expect(maskText('ts=1788591675300')).toContain('1788591675300');
    expect(maskText('ts=1788591675301')).toContain('1788591675301');
  });

  it('o_ 前缀的内部 ID 不当成 openid', () => {
    const id = 'o_01J8ZK3M7N5P9QRSTVWXY';
    expect(maskText(`id=${id}`)).toContain(id);
  });

  it('真 openid 仍然被掩码（28 位、第二位是字母数字）', () => {
    const openid = 'o6_bmjrPTlm6_2sgVt7hMZOPfL2M';
    expect(maskText(`openid=${openid}`)).not.toContain(openid);
  });

  it('真卡号仍然被掩码（含空格 / 连字符分隔）', () => {
    expect(maskText('pan 4242 4242 4242 4242')).toContain('***4242');
    expect(maskText('pan 4242-4242-4242-4242')).toContain('***4242');
    expect(maskText('amex 378282246310005')).toContain('***0005');
    expect(maskText('jcb 3530111333300000')).toContain('***0000');
  });
});

/** D12：数字形态的敏感值不能被"只处理字符串"漏掉。 */
describe('数字形态（D12）', () => {
  it('数字卡号在非敏感键名下也被掩码', () => {
    const out = redact({ note: 4242424242424242 }) as Record<string, unknown>;
    expect(out.note).toBe('***4242');
  });

  it('敏感键名下的数字（电话 / 卡号）保留后 4 位', () => {
    const out = redact({ phone: 9012345678, card_no: 4242424242424242 }) as Record<string, unknown>;
    expect(out.phone).toBe('***5678');
    expect(out.card_no).toBe('***4242');
  });

  it('金额与时间戳数字不受影响', () => {
    const out = redact({
      amount_jpy: 12800,
      duration_ms: 1788591675300,
      count: 7,
      ratio: 0.15,
    }) as Record<string, unknown>;
    expect(out.amount_jpy).toBe(12800);
    expect(out.duration_ms).toBe(1788591675300);
    expect(out.count).toBe(7);
    expect(out.ratio).toBe(0.15);
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
