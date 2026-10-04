/**
 * 职责：脱敏的 L0 单测 + 属性测试（F5）。
 * 脱敏是安全红线，这里刻意测"漏了会怎样"而不是"成功了怎样"：每条断言都是"原值不得出现在输出里"。
 * @see docs/代码注释规范与日志体系设计.md（脱敏红线）；docs/地基搭建清单.md F5
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { capForLog, isSensitiveKey, maskText, redact } from './redact.js';

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

/**
 * 三类脱敏口径（二审 N5/N6，AJ-33）。
 *
 * @why 旧实现对所有敏感键一律"保留尾 4 位数字"：那是为卡号/电话设计的（排查要关联），
 *      但作用在口令/密钥上时，`password:'Summer2024'` → `***2024`、密钥尾号 → `***9876`——
 *      尾 4 位数字恰是撞库高价值片段（N5）。反过来，收货人 PII（姓名/地址/邮编）
 *      根本不在词表里，会明文落盘（N6）。三类的泄露后果与排查需求都不同，一刀切两头都错。
 */
describe('三类脱敏口径（N5/N6，AJ-33）', () => {
  it('SECRET 类：整值 ***，任何片段都不保留（口令里的年份、密钥尾号都是撞库素材）', () => {
    const out = redact({
      password: 'Summer2024',
      api_key: 'sk_live_1234567890abcdef9876',
      stripe_secret: 'whsec_abcd1234',
      token: 'tok-987654',
      authorization: 'Bearer abc.def.ghi',
      credential: 'cred-2024',
      signature: 'sig9876',
      nonce: 'n-998877',
      cvv: 123,
      cookie: 'session=abc123',
    }) as Record<string, unknown>;
    for (const k of [
      'password',
      'api_key',
      'stripe_secret',
      'token',
      'authorization',
      'credential',
      'signature',
      'nonce',
      'cvv',
      'cookie',
    ]) {
      expect(out[k], `key=${k} 不得保留任何片段`).toBe('***');
    }
  });

  it('IDENTIFIER 类：保留尾 4 位 / 邮箱域名（对账排障要对得上号，且片段单独不构成凭证）', () => {
    const out = redact({
      phone: '09012345678',
      card_no: '4242424242424242',
      email: 'hanako@example.com',
      mobile: '+81 90-1234-5678',
    }) as Record<string, unknown>;
    expect(out.phone).toBe('***5678');
    expect(out.card_no).toBe('***4242');
    expect(out.email).toBe('h***@example.com');
    expect(out.mobile).toBe('***5678');
  });

  it('PII 类：地址行/邮编整值遮蔽，姓名保留首字母，address_snapshot 整对象遮蔽', () => {
    const out = redact({
      recipient: 'Tanaka Hanako',
      first_name: 'Hanako',
      last_name: 'Tanaka',
      line1: '1-2-3 Sakura Ave',
      line2: 'Apt 501',
      street: 'Sakura Ave',
      postal_code: '100-0001',
      zip: '94108',
      address_snapshot: { recipient: 'Tanaka', line1: '1-2-3', postal_code: '100-0001' },
      // AJ-33 的两个保守边界：城市保留（不构成个人识别，运费/关税排查要看）；裸 name 不入表（防误伤业务字段）
      city: 'Tokyo',
      product_name: '三德厨刀',
    }) as Record<string, unknown>;
    expect(out.recipient).toBe('T***');
    expect(out.first_name).toBe('H***');
    expect(out.last_name).toBe('T***');
    expect(out.line1).toBe('***');
    expect(out.line2).toBe('***');
    expect(out.street).toBe('***');
    expect(out.postal_code).toBe('***');
    expect(out.zip).toBe('***');
    expect(out.address_snapshot).toBe('***');
    expect(out.city).toBe('Tokyo');
    expect(out.product_name).toBe('三德厨刀');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // `…_id` / `…_ids` 是**引用**不是**内容**（AJ-355）
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // @why 🔴 词表制的固有坑：`address_id` 切词得 `address` → 命中 PII-地址词表 → 整值 `***`。
  //      但 `address_id` 是服务端生成的定位键（`addr-<uuid>`），与 `order_id` / `trace_id` 同类，
  //      本文件自己的 @limitation 写着"排查靠的是编号，从不需要在日志里看到完整地址"。
  //      实际受害面：地址 CRUD 三条业务日志、`DELETE /addresses/{id}` 的 40400、
  //      建单时"地址不存在"的 40400（create-order.ts）——**全都不带得出来是哪一个 id**。
  //      用户投诉"我的默认地址怎么变了"时，日志只能回答"有过一次改动"：遮蔽的是线索本身。
  // @why 反例必须同时断言（只测"活下来"会留下一个更危险的口子）：
  //      ① 不带 `_id` 的地址**内容**仍整值遮蔽（`address` / `addresses`）；
  //      ② 红线：`openid` / `unionid` 的 squeezed 也以 `id` 结尾，若把豁免放到
  //         IDENTIFIER 判定**之前**，身份标识就会被整条放行——所以下面显式钉死它们仍被遮蔽。
  it('🔴 `…_id`/`…_ids` 是引用键（保留），但地址内容与 openid 仍按原规则遮蔽', () => {
    const out = redact({
      // —— 引用键：必须原样保留，否则排障断链 ——
      address_id: 'addr-01J8ZK3M7N5P9QRSTVWXY',
      address_ids: ['addr-a', 'addr-b'],
      recipient_id: 'rcp-1',
      // —— 反例①：内容是内容，不带 `_id` 就没有豁免 ——
      address: '1-2-3 Sakura Ave',
      addresses: [{ line1: '1-2-3' }],
      recipient: 'Tanaka Hanako',
      // —— 反例②（红线）：squeezed 同样以 `id` 结尾，但走 SECRET/IDENTIFIER，豁免碰不到它们 ——
      openid: 'o6_bmjrPTlm6_2sgVt7hMZOPfL2M',
      api_key: 'sk_live_abc',
    }) as Record<string, unknown>;

    expect(out.address_id).toBe('addr-01J8ZK3M7N5P9QRSTVWXY');
    expect(out.address_ids).toEqual(['addr-a', 'addr-b']);
    expect(out.recipient_id).toBe('rcp-1');

    expect(out.address).toBe('***');
    expect(out.addresses).toEqual([{ line1: '***' }]);
    expect(out.recipient).toBe('T***');

    // 不写死具体掩码串（那是 maskIdentifier 的实现细节），钉死"确实被遮蔽了且不是原值"
    expect(String(out.openid)).toMatch(/^\*\*\*/);
    expect(out.api_key).toBe('***');
  });

  it('嵌套对象里的收货人字段同样按 PII 遮蔽（N6 的真实形态：地址对象在 ctx/details 里）', () => {
    const out = redact({
      ctx: { recipient: 'Tanaka', line1: '1-2-3 Sakura', zip: '94108', city: 'SF' },
    }) as Record<string, unknown>;
    const ctx = out.ctx as Record<string, unknown>;
    expect(ctx.recipient).toBe('T***');
    expect(ctx.line1).toBe('***');
    expect(ctx.zip).toBe('***');
    expect(ctx.city).toBe('SF');
  });

  it('PII 的空值不产生掩码噪音', () => {
    const out = redact({ recipient: '', line1: null }) as Record<string, unknown>;
    expect(out.recipient).toBe('');
    expect(out.line1).toBeNull();
  });

  it('last_login 不被误伤（last 太通用，只有整键 lastname 才算姓名）', () => {
    const out = redact({ last_login: '2026-09-23T10:00:00Z' }) as Record<string, unknown>;
    expect(out.last_login).toBe('2026-09-23T10:00:00Z');
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

/**
 * N16 覆盖率缺口的定向补齐——每一条例都对应 v8 报告里一个真实未走的分支。
 * 不是为凑数字：这些分支（function/symbol/无栈 Error/非字符串姓名/小数标识符）
 * 都是"意外类型流入日志"时的行为，不钉住就可能在某次重构里悄悄改变。
 */
describe('意外类型的脱敏行为（N16 定向）', () => {
  it('isSensitiveKey 直接可调（与 classifyKey 一致的布尔视图）', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('openid')).toBe(true);
    expect(isSensitiveKey('product_name')).toBe(false);
  });

  it('function 值 → 占位串（函数进日志没有可读形态，但不能原样序列化）', () => {
    const out = redact({ callback: () => undefined }) as Record<string, unknown>;
    expect(out.callback).toBe('[Function]');
  });

  it('symbol 值 → toString（ Symbol 不能 JSON 序列化，原样会让 pino 丢字段）', () => {
    const out = redact({ sym: Symbol('trace-marker') }) as Record<string, unknown>;
    expect(out.sym).toBe('Symbol(trace-marker)');
  });

  it('Error 没有 stack 时不产出 err_stack 键（不能假设所有 Error 都带栈）', () => {
    const e = new Error('no stack here');
    delete e.stack;
    const out = redact({ err: e }) as { err: { err_stack?: string } };
    expect(out.err.err_stack).toBeUndefined();
  });

  it('PII 姓名键收到非字符串（意外传对象/数字）→ 整值掩码而不是取"首字母"', () => {
    const out = redact({ recipient: 123456, fullname: { nested: true } }) as Record<
      string,
      unknown
    >;
    expect(out.recipient).toBe('***');
    expect(out.fullname).toBe('***');
  });

  it('IDENTIFIER 键收到小数 → 整值掩码（"尾 4 位"对小数没有语义）', () => {
    const out = redact({ card_no: 1.5, phone: true }) as Record<string, unknown>;
    expect(out.card_no).toBe('***');
    expect(out.phone).toBe('***');
  });
});

/**
 * 三审 S2：约束七红线"支付链接 token 一律不进日志"此前有四类漏网形态，逐条钉住。
 */
describe('三审 S2：支付链接 / 复数键 / 凭证形状的自由文本', () => {
  it('URL 类键（url / link / href / pay_url / entry.url）去掉查询串与哈希，并抹掉像 token 的路径段', () => {
    const out = redact({
      pay_url:
        'https://checkout.stripe.com/c/pay/cs_live_b1SECRETTOKENabcdefghijklmnop#fidkdWxOYHwnPyd1blpxYHZxWjA0',
      entry: { url: 'https://pay.waselect.jp/o/o_01J8ZK3M7N?t=9f8e7d6c5b4a3f2e1d0c9b8a' },
      link: 'https://api.stripe.com/v1/checkout/sessions',
    }) as Record<string, unknown>;
    expect(out.pay_url).toBe('https://checkout.stripe.com/c/pay/***');
    expect((out.entry as Record<string, unknown>).url).toBe(
      'https://pay.waselect.jp/o/o_01J8ZK3M7N',
    );
    // 普通 API 路径保持可读（排障要看打到哪个端点）
    expect(out.link).toBe('https://api.stripe.com/v1/checkout/sessions');
  });

  it('复数键（tokens / secrets / passwords / api_keys）与单数同样整值遮蔽', () => {
    const out = redact({
      tokens: ['tok_x', 'tok_y'],
      secrets: { a: 'b' },
      passwords: ['Summer2024!'],
      api_keys: ['k1'],
    }) as Record<string, unknown>;
    expect(out.tokens).toBe('***');
    expect(out.secrets).toBe('***');
    expect(out.passwords).toBe('***');
    expect(out.api_keys).toBe('***');
  });

  it('自由文本里的 Stripe 密钥 / webhook 密钥 / Bearer / JWT / Checkout Session id 被掩码', () => {
    const text =
      'key sk_live_51Habcdefghijklmnop and whsec_ABCDEFGHIJKLMNOP with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJl session cs_test_a1B2c3D4e5F6g7H8';
    const masked = maskText(text);
    expect(masked).not.toContain('sk_live_51Habcdefghijklmnop');
    expect(masked).not.toContain('whsec_ABCDEFGHIJKLMNOP');
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJl');
    expect(masked).not.toContain('cs_test_a1B2c3D4e5F6g7H8');
    expect(masked).toContain('sk_live_***');
    expect(masked).toContain('Bearer ***');
  });

  it('裸 JWT（不带 Bearer）保留 eyJ 前缀；URL 类键取值不是字符串时整体打星', () => {
    expect(maskText('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJl')).toBe(
      'token=eyJ***',
    );
    // null 原样透传（不是敏感值，且 JSON 里 null 与缺省语义不同），非字符串的非空值才整体打星
    const out = redact({ url: 12345, link: null }) as Record<string, unknown>;
    expect(out.url).toBe('***');
    expect(out.link).toBeNull();
  });

  it('Error 的 message 与 stack 同样经过文本脱敏（三审变异 U21：此前无用例钉住）', () => {
    const err = new Error('stripe 建会话失败：sk_test_abcdefghijklmnop 对 bob@example.com');
    const out = redact(err) as Record<string, unknown>;
    expect(out.err_message).not.toContain('sk_test_abcdefghijklmnop');
    expect(out.err_message).toContain('b***@example.com');
    expect(String(out.err_stack)).not.toContain('sk_test_abcdefghijklmnop');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// capForLog：日志出口的**限长**（CAT2-03 / AJ-356）
// ═══════════════════════════════════════════════════════════════════════════
//
// @why 与脱敏分开测：它管的不是"敏感不敏感"而是"多长"，且**不在** redact() 里——
//      admin-audit 拿 redact 算落库的审计值，那条路**不能**被限长（见下面第三条用例）。
describe('capForLog（日志出口限长，与脱敏是两件事）', () => {
  it('🔴 超长字符串被截断，且**留可见标记**（不能让人把截断值当完整值去查库）', () => {
    const long = 'a'.repeat(8000);
    const out = capForLog({ http_path: long }) as Record<string, unknown>;
    const v = String(out['http_path']);
    expect(v.length).toBeLessThan(600);
    expect(v.startsWith('a'.repeat(512))).toBe(true);
    expect(v).toContain('…(+7488 字符)'); // 8000 - 512
    expect(v).not.toContain('a'.repeat(600));
  });

  it('不超过上限的串原样保留（限长不得误伤正常字段）', () => {
    const out = capForLog({ product_id: 'p-1', note: 'x'.repeat(512) }) as Record<string, unknown>;
    expect(out['product_id']).toBe('p-1');
    expect(out['note']).toBe('x'.repeat(512)); // 恰好等于上限 → 不截
  });

  it('嵌套与数组逐元素截断；数字/布尔/null 不受影响', () => {
    const long = 'b'.repeat(900);
    const out = capForLog({
      ctx: { rows: [long, 1, true, null] },
      n: 12345,
    }) as Record<string, unknown>;
    const ctx = out['ctx'] as Record<string, unknown>;
    const rows = ctx['rows'] as unknown[];
    expect(String(rows[0])).toContain('…(+388 字符)');
    expect(rows[1]).toBe(1);
    expect(rows[2]).toBe(true);
    expect(rows[3]).toBeNull();
    expect(out['n']).toBe(12345);
  });

  it('🔴 err_stack 豁免：堆栈是我们自己的内容，且是最需要看完整的那一处', () => {
    const stack = 'Error: boom\n' + '    at f (/app/x.ts:1:1)\n'.repeat(200); // 约 5.2KB
    const out = capForLog({ err_type: 'Error', err_stack: stack }) as Record<string, unknown>;
    // 未截断：长度一致
    expect(out['err_stack']).toBe(stack);
    // 对照：同长度的普通字符串会被截（证明豁免不是"整条没走 capForLog"）
    const other = capForLog({ other: stack }) as Record<string, unknown>;
    expect(String(other['other'])).toContain('…(+');
  });

  // @why 这条是**反向**用例，守住 capForLog 的设计前提：
  //      redact() 的第二个消费方是审计落库（admin-audit.ts 的 `auditPayload`），
  //      它的输出要**完整**进 append-only 的审计表。若哪天有人把限长挪进 redact()，
  //      这条会红——它红的含义是"审计数据开始被截断了"。
  it('深度超过上限 → `[Deep]`（与 redact 同一口径，防自引用/超深对象拖死日志进程）', () => {
    const long = 'z'.repeat(900);
    // 第 7 层（`MAX_DEPTH = 6`）不再展开
    const out = capForLog({ a: { b: { c: { d: { e: { f: { g: long } } } } } } }) as Record<
      string,
      unknown
    >;
    expect(out).toMatchObject({ a: { b: { c: { d: { e: { f: '[Deep]' } } } } } });
  });

  it('🔴 redact() 本身**不**限长（审计落库值必须完整）', () => {
    const long = 'c'.repeat(900);
    const out = redact({ description: long }) as Record<string, unknown>;
    expect(out['description']).toBe(long);
  });
});
