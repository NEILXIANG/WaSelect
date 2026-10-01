/**
 * 职责：`utils/address-form.js` 的单测。
 *
 * @why 钉的都是"错了不报错 / 报错指向错地方"的事：
 *      ① 前端正则与契约 pattern 漂移 → 前端说对、服务端 400（用户只看到"提交失败"）；
 *      ② `line2` 被删字段而不是传空串 → 用户清空第二行却没生效，UI 上看不出区别；
 *      ③ 州名小写 `ca` 原样送出 → 面单上成了另一个值；
 *      ④ 摘要拼出 `San Francisco, , CA` 双逗号 → "地址显示错了"但没人知道为什么。
 *
 * @limitation 一：契约比对用正则解析 YAML 文本（与 `check-contract.mjs` 同口径，不引 YAML 依赖）；
 *              契约把 AddressInput 改写成多行就会失配——那种改动本来也该被 review 拦下。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_COUNTRY_DEFAULT,
  ADDRESS_MAX_CHARS,
  ADDRESS_PATTERNS,
  addressSummary,
  defaultAddressId,
  emptyForm,
  formErrors,
  formModel,
  toAddressInput,
} from './address-form.js';
import { US_ADDRESSES, US_ADDRESS_INVALID, formatUsPhone } from '../../test/factories/catalog.js';
import { ADDRESS_MAX_CHARS as SERVER_MAX } from '../../server/src/domain/address-input.js';

/** 像真的美国地址（约束三：真实城市/州/邮编组合，不是 aaa/bbb）。 */
const ADDR = {
  id: 'addr-1',
  recipient: 'Ken Tanaka',
  phone: '+14155550123',
  line1: '1234 Market St',
  line2: 'Apt 5B',
  city: 'San Francisco',
  state: 'CA',
  postal_code: '94102-1234',
  country: 'US',
  is_default: true,
};

describe('emptyForm / formModel', () => {
  it('空表单七个字段齐全且为空串', () => {
    const f = emptyForm();
    expect(Object.keys(f).sort()).toEqual(
      ['city', 'is_default', 'line1', 'line2', 'phone', 'postal_code', 'recipient', 'state'].sort(),
    );
    expect(f.recipient).toBe('');
    expect(f.is_default).toBe(false);
  });

  it('服务端地址 → 表单（含 is_default）', () => {
    expect(formModel(ADDR)).toEqual({
      recipient: 'Ken Tanaka',
      phone: '+14155550123',
      line1: '1234 Market St',
      line2: 'Apt 5B',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94102-1234',
      is_default: true,
    });
  });

  it('⚠️ 州名小写 → 归一成大写（@limitation 二）', () => {
    expect(formModel({ ...ADDR, state: 'ca' }).state).toBe('CA');
    expect(toAddressInput({ ...ADDR, state: 'ny' }).state).toBe('NY');
  });

  it('脏输入：null / 非对象 / 字段类型不对 → 空串而不是 undefined', () => {
    expect(formModel(null).recipient).toBe('');
    expect(formModel('x').state).toBe('');
    expect(formModel({ recipient: 42, is_default: 'yes' }).recipient).toBe('');
    expect(formModel({ is_default: 'yes' }).is_default).toBe(false);
  });
});

describe('formErrors（格式预检）', () => {
  it('合法表单 → ok，无错误', () => {
    const r = formErrors(formModel(ADDR));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
    expect(r.first).toBe('');
  });

  it('⚠️ 多字段同时错 → 全部返回（不是一个一个报，让用户提交七次）', () => {
    const r = formErrors({ ...emptyForm(), recipient: '田中', phone: '4155550123' });
    expect(r.ok).toBe(false);
    // 六个：空表单里除 line2（允许空）外全不合法，加上中收件人
    expect(Object.keys(r.errors).sort()).toEqual(
      ['city', 'line1', 'phone', 'postal_code', 'recipient', 'state'].sort(),
    );
    // `first` 按**校验顺序**取第一条（= 字段顺序），不是按字母序
    expect(r.first).toBe(r.errors.recipient);
    expect(r.first).toContain('收件人');
  });

  it('电话少 +1 / 邮编非 5 位 / 州非两位 → 各自有对应提示', () => {
    expect(formErrors({ ...formModel(ADDR), phone: '4155550123' }).errors.phone).toContain('+1');
    expect(formErrors({ ...formModel(ADDR), postal_code: '9410' }).errors.postal_code).toContain(
      '5 位',
    );
    expect(formErrors({ ...formModel(ADDR), state: 'CAL' }).errors.state).toContain('两位');
  });

  it('⚠️ 全角 / 中文收件人被拒（面单不接受）', () => {
    expect(formErrors({ ...formModel(ADDR), recipient: '田中　健' }).ok).toBe(false);
  });

  it('line2 允许留空（契约 `^[ -~]*$`）', () => {
    expect(formErrors({ ...formModel(ADDR), line2: '' }).ok).toBe(true);
  });

  it('首尾空白被 trim 后通过（用户看不见自己多打了一个空格）', () => {
    expect(formErrors({ ...formModel(ADDR), city: '  San Francisco  ' }).ok).toBe(true);
  });
});

describe('toAddressInput（请求体）', () => {
  it('七字段 + country + is_default，且都 trim', () => {
    expect(toAddressInput({ ...formModel(ADDR), line1: '  1234 Market St  ' })).toEqual({
      recipient: 'Ken Tanaka',
      phone: '+14155550123',
      line1: '1234 Market St',
      line2: 'Apt 5B',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94102-1234',
      country: 'US',
      is_default: true,
    });
  });

  it('⚠️ line2 空串**保留**而不是删字段——删了等于"改了但没生效"', () => {
    const body = toAddressInput({ ...formModel(ADDR), line2: '' });
    expect(Object.keys(body)).toContain('line2');
    expect(body.line2).toBe('');
  });

  it('country 固定取 ADDRESS_COUNTRY_DEFAULT（MVP 单一目的国，@limitation 一）', () => {
    expect(ADDRESS_COUNTRY_DEFAULT).toBe('US');
    expect(toAddressInput({ ...formModel(ADDR), country: 'JP' }).country).toBe('US');
  });
});

describe('addressSummary（摘要行）', () => {
  it('region = 城市, 州, 邮编', () => {
    expect(addressSummary(ADDR)).toEqual({
      recipient: 'Ken Tanaka',
      phone: '+14155550123',
      line1: '1234 Market St',
      line2: 'Apt 5B',
      region: 'San Francisco, CA, 94102-1234',
    });
  });

  it('⚠️ 缺 city / 空 line2 → 不出现双逗号', () => {
    const s = addressSummary({ ...ADDR, city: '', line2: '' });
    expect(s.region).toBe('CA, 94102-1234');
    expect(s.region).not.toContain(', ,');
    expect(s.region).not.toMatch(/,{2}/);
  });

  it('脏输入：null → 全空串，不抛', () => {
    expect(addressSummary(null).region).toBe('');
    expect(addressSummary(undefined).recipient).toBe('');
  });
});

describe('defaultAddressId（预选地址）', () => {
  it('is_default 优先于第一条', () => {
    const list = [
      { id: 'a', is_default: false },
      { id: 'b', is_default: true },
    ];
    expect(defaultAddressId(list)).toBe('b');
  });

  it('无 is_default → 取第一条；空列表 / 脏输入 → 空串', () => {
    expect(defaultAddressId([{ id: 'a' }, { id: 'b' }])).toBe('a');
    expect(defaultAddressId([])).toBe('');
    expect(defaultAddressId(null)).toBe('');
    expect(defaultAddressId([{ noId: 1 }])).toBe('');
  });
});

/**
 * ⚠️ 与契约的双向比对：前端正则的 `source` 必须**等于** yaml 里的 pattern 字符串。
 * @why 这是"两处真值"的唯一缝合线：缺了它，改了契约不改前端的表现是
 *      "前端校验全过、服务端 40001"，而用户只看到"提交失败"，没人知道是格式。
 */
describe('与契约 AddressInput 的双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../contracts/api-contract.yaml'), 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('AddressInput:')) ?? '';

  /** 契约字段名 → 本模块的正则键（显式元组类型：`Object.entries` 会把值放宽成联合 + undefined）。 */
  const ENTRIES: Array<[string, keyof typeof ADDRESS_PATTERNS]> = [
    ['recipient', 'ascii'],
    ['phone', 'phone'],
    ['line1', 'ascii'],
    ['line2', 'asciiOptional'],
    ['city', 'ascii'],
    ['postal_code', 'postal'],
  ];

  it('抽到了 AddressInput 那一行（契约改写成多行会失配，@limitation 一）', () => {
    expect(line).toContain('AddressInput');
    expect(line).toContain('pattern');
  });

  it.each(ENTRIES)('字段 %s 的 pattern 与前端正则一致', (field, key) => {
    const m = new RegExp(`${field}: \\{type: string, pattern: '([^']+)'\\}`).exec(line);
    expect(m?.[1], `契约里没找到 ${field} 的 pattern`).toBeTruthy();
    expect(ADDRESS_PATTERNS[key].source).toBe(m?.[1]);
  });

  it('州：契约约束长度 2（大小写由本模块归一，@limitation 二）', () => {
    const m = /state: \{type: string, minLength: 2, maxLength: 2\}/.exec(line);
    expect(m?.[0]).toBeTruthy();
    expect(ADDRESS_PATTERNS.state.source).toBe('^[A-Z]{2}$');
  });
});

/**
 * 形态清单的样本池接进前端预检（第三轮审查 TST3-02，与服务端 address-input 同池）。
 * @why 见 `server/src/domain/address-input.unit.test.ts` 同名段：原来只有 CA 一种州码，
 *      前端把州码收紧成 50 州白名单时全绿，驻日美军与波多黎各买家在表单上就被拦下。
 */
describe('US_ADDRESSES / US_ADDRESS_INVALID 样本池（TST3-02）', () => {
  it.each(US_ADDRESSES.map((s) => [`${s.recipient} / ${s.state} ${s.postalCode}`, s] as const))(
    '合法样本通过预检：%s',
    (_label, s) => {
      const r = formErrors({
        recipient: s.recipient,
        phone: formatUsPhone(s.areaCode, 5_000_000),
        line1: s.line1,
        line2: s.line2 ?? '',
        city: s.city,
        state: s.state,
        postal_code: s.postalCode,
      });
      expect(r.errors).toEqual({});
    },
  );

  it.each(US_ADDRESS_INVALID.map((c) => [c.name, c] as const))('反例被预检拦下：%s', (_n, c) => {
    expect(formErrors({ ...ADDR, ...c.patch }).ok).toBe(false);
  });
});

describe('ADDRESS_MAX_CHARS 与服务端同源（TST3-02）', () => {
  it('逐键相等', () => {
    expect(ADDRESS_MAX_CHARS).toEqual(SERVER_MAX);
  });
  it('刚好到上限放行、超 1 个字符拦下', () => {
    expect(formErrors({ ...ADDR, line2: 'A'.repeat(200) }).errors.line2).toBeUndefined();
    expect(formErrors({ ...ADDR, line2: 'A'.repeat(201) }).errors.line2).toBe('最多 200 个字符');
  });
});
