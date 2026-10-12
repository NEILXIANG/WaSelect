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
  ENGLISH_ADDRESS_NOTE,
  addressSummary,
  defaultAddressId,
  emptyForm,
  normalizeUsPhone,
  formErrors,
  zipMatchesState,
  formModel,
  toAddressInput,
  phoneForInput,
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
    const r = formErrors({ ...emptyForm(), recipient: '田中', phone: '415555012' });
    expect(r.ok).toBe(false);
    // 六个：空表单里除 line2（允许空）外全不合法，加上中收件人
    expect(Object.keys(r.errors).sort()).toEqual(
      ['city', 'line1', 'phone', 'postal_code', 'recipient', 'state'].sort(),
    );
    // `first` 按**校验顺序**取第一条（= 字段顺序），不是按字母序
    expect(r.first).toBe(r.errors.recipient);
    expect(r.first).toContain('收件人');
  });

  // 三端模拟测试 2026-10-11（新用户首单）：什么都没填就点保存，收件人提示"请用英文/数字填写"——
  //   用户一个字没写，却被说"写的不是英文"。空的说"请填写"，填了中文才说"请用英文"
  it('🔴 空字段说"请填写××"（带英文示例）；填了中文才说"请用英文"', () => {
    const empty = formErrors(emptyForm()).errors;
    expect(empty.recipient).toBe('请填写收件人姓名（英文，如 Ken Tanaka）');
    expect(empty.phone).toBe('请填写美国电话号码（10 位，如 4155550123）');
    expect(empty.line1).toBe('请填写街道地址（英文，如 350 5th Ave）');
    expect(empty.city).toBe('请填写城市（英文，如 New York）');
    expect(empty.postal_code).toBe('请填写邮编（5 位，如 94105）');
    const zh = formErrors({
      ...emptyForm(),
      recipient: '张三',
      line1: '朝阳区',
      city: '北京',
    }).errors;
    expect(zh.recipient).toContain('请用英文');
    expect(zh.line1).toContain('请用英文');
    expect(zh.city).toContain('请用英文');
  });

  it('电话位数不对 / 邮编非 5 位 / 州非两位 → 各自有对应提示', () => {
    // 统一结论 5.3：电话框是数字键盘，打不出「+」——提示只说能打出来的写法（10 位，或 1 开头 11 位），不叫人输 +1
    const phoneErr = formErrors({ ...formModel(ADDR), phone: '415555012' }).errors.phone ?? '';
    expect(phoneErr).toContain('10 位');
    expect(phoneErr).toContain('4155550123');
    expect(phoneErr).not.toContain('+');
    expect(formErrors({ ...formModel(ADDR), postal_code: '9410' }).errors.postal_code).toContain(
      '5 位',
    );
    expect(formErrors({ ...formModel(ADDR), state: 'CAL' }).errors.state).toContain('两位');
    // 三端走查小白视角（2026-10-10）：州是下拉选择，没选时说"两位大写缩写"是术语——只说"请选择州"
    expect(formErrors({ ...formModel(ADDR), state: '' }).errors.state).toBe('请选择州');
    expect(formErrors({ ...formModel(ADDR), state: '  ' }).errors.state).toBe('请选择州');
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
  // 三端模拟测试 2026-10-11：地址列表 / 结算 / 订单详情显示 "+16175550123"，一串数字不好读；美国习惯 (617) 555-0123
  it('🔴 region = 城市, 州, 邮编；电话按美国习惯分段显示（提交给服务端的仍是 E.164，见 toAddressInput）', () => {
    expect(addressSummary(ADDR)).toEqual({
      recipient: 'Ken Tanaka',
      phone: '+1 (415) 555-0123',
      line1: '1234 Market St',
      line2: 'Apt 5B',
      region: 'San Francisco, CA, 94102-1234',
    });
  });

  it('形状认不出的电话原样显示（旧数据 / 别国号码不硬套格式）', () => {
    expect(addressSummary({ ...ADDR, phone: '+819012345678' }).phone).toBe('+819012345678');
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

  // 0.6.27（契约批次）：契约给各字段补了 `maxLength`，字段对象里的**键顺序不再固定**——
  // 旧写法把 `{type: string, pattern: …}` 写死，加一个键就整条失配（"契约里没找到 pattern"）。
  // 改成 `[^}]*` 跳过该字段对象内的其它键：断言的仍是"这个字段的 pattern 是什么"，
  // 不再顺带把键顺序也钉住（按行正则的固有脆性，见上一条 @limitation 一）。
  it.each(ENTRIES)('字段 %s 的 pattern 与前端正则一致', (field, key) => {
    const m = new RegExp(`${field}: \\{[^}]*pattern: '([^']+)'`).exec(line);
    expect(m?.[1], `契约里没找到 ${field} 的 pattern`).toBeTruthy();
    expect(ADDRESS_PATTERNS[key].source).toBe(m?.[1]);
  });

  it('州：契约约束长度 2（大小写由本模块归一，@limitation 二）', () => {
    const m = /state: \{[^}]*minLength: 2[^}]*maxLength: 2/.exec(line);
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

  /**
   * P2-37 之后有一类反例**不再被拦**，而是被前端修好：带分隔符的本土电话（212-555-0000）
   * 对数据库仍是非法值（样本池服务于 DB CHECK 用例，不改），但前端会先归一成 E.164 再发。
   * 所以这里分两路断言：能被归一的 → 发出去的值合法；其余 → 预检拦下。
   */
  const fixable = (c: (typeof US_ADDRESS_INVALID)[number]): boolean =>
    typeof c.patch.phone === 'string' && normalizeUsPhone(c.patch.phone) !== c.patch.phone.trim();

  it.each(US_ADDRESS_INVALID.filter((c) => !fixable(c)).map((c) => [c.name, c] as const))(
    '反例被预检拦下：%s',
    (_n, c) => {
      expect(formErrors({ ...ADDR, ...c.patch }).ok).toBe(false);
    },
  );

  it.each(US_ADDRESS_INVALID.filter(fixable).map((c) => [c.name, c] as const))(
    '反例被前端归一修好（发出去的是合法 E.164）：%s',
    (_n, c) => {
      expect(formErrors({ ...ADDR, ...c.patch }).ok).toBe(true);
      expect(ADDRESS_PATTERNS.phone.test(toAddressInput({ ...ADDR, ...c.patch }).phone)).toBe(true);
    },
  );
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

describe('州码白名单（剩余清单 4-5）', () => {
  it('🔴 两位大写但不是真实州码（XX）→ 报错，提示从列表选；真实州码（含 DC / PR / AE）→ 不报', () => {
    expect(formErrors({ ...formModel(ADDR), state: 'XX' }).errors.state).toContain('列表');
    for (const st of ['DC', 'PR', 'AE']) {
      expect(formErrors({ ...formModel(ADDR), state: st }).errors.state).toBeUndefined();
    }
  });
});

describe('normalizeUsPhone：美国电话常见写法归一成 E.164（P2-37）', () => {
  it('🔴 常见写法 → +14155550123', () => {
    for (const raw of [
      '(415) 555-0123',
      '415-555-0123',
      '1 415 555 0123',
      '+1 415-555-0123',
      '415.555.0123',
      '4155550123',
      ' +14155550123 ',
      '+1 (415) 555-0123',
    ]) {
      expect(normalizeUsPhone(raw), raw).toBe('+14155550123');
    }
  });

  it('认不出的不硬改（原样 trim 后交给校验去拒，不猜）', () => {
    expect(normalizeUsPhone('415555012')).toBe('415555012'); // 9 位
    expect(normalizeUsPhone('2 415 555 0123')).toBe('2 415 555 0123'); // 11 位但不是 1 开头
    expect(normalizeUsPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958'); // 外国号
    expect(normalizeUsPhone('+4155550123')).toBe('+4155550123'); // 带 + 却没有国家码 1
    expect(normalizeUsPhone('415-555-0123 ext 9')).toBe('415-555-0123 ext 9');
    expect(normalizeUsPhone(undefined)).toBe('');
  });

  it('formErrors 按归一后的值校验；toAddressInput 发出去的是 E.164（服务端规则 ^\\+1\\d{10}$ 不变）', () => {
    const m = { ...formModel(ADDR), phone: '(415) 555-0123' };
    expect(formErrors(m).errors.phone).toBeUndefined();
    expect(toAddressInput(m).phone).toBe('+14155550123');
    expect(ADDRESS_PATTERNS.phone.test(toAddressInput(m).phone)).toBe(true);
  });
});

describe('ENGLISH_ADDRESS_NOTE（M-20 英文填写说明，AJ-406）', () => {
  it('🔴 每条示例值都能通过本表单的校验（示例自己填不进去 = 说明是错的）', () => {
    expect(ENGLISH_ADDRESS_NOTE.examples.map((x) => x.key)).toEqual([
      'recipient',
      'line1',
      'line2',
    ]);
    const model = { ...ADDR };
    for (const ex of ENGLISH_ADDRESS_NOTE.examples) {
      expect(ADDRESS_PATTERNS.ascii.test(ex.value), ex.value).toBe(true);
      (model as Record<string, unknown>)[ex.key] = ex.value;
    }
    expect(formErrors(formModel(model)).errors).toEqual({});
  });

  it('说明与字段错误同一口径：中文填进去会被拒（说明说"无法提交"必须是真的）', () => {
    expect(ENGLISH_ADDRESS_NOTE.body).toContain('无法提交');
    expect(
      formErrors(formModel({ ...ADDR, line1: '东京都千代田区 1-1' })).errors.line1,
    ).toBeTruthy();
  });
});

describe('电话用数字键盘（小程序评估 A12，2026-10-09）', () => {
  // 全入口点击测试 2026-10-11：编辑页电话显示成 "16175550197"（11 位），与输入框示例"4155550123（美国 10 位号码）"对不上；
  // 框左侧固定写 +1，框里只放 10 位本地号
  it('🔴 phoneForInput：美国号去掉 +1 只留 10 位（框左侧固定写 +1）；其它去掉开头的 +；normalizeUsPhone 还原成 +1 开头', () => {
    expect(phoneForInput('+14155550123')).toBe('4155550123');
    expect(phoneForInput('+8613800138000')).toBe('8613800138000');
    expect(phoneForInput('4155550123')).toBe('4155550123');
    expect(phoneForInput(undefined)).toBe('');
    expect(normalizeUsPhone(phoneForInput('+14155550123'))).toBe('+14155550123');
    expect(normalizeUsPhone('4155550123')).toBe('+14155550123');
  });
});

// 三端模拟测试 2026-10-11（新用户首单）：州下拉误选成内华达（NV），邮编填纽约的 10013，照样存上了——
//   面单写成 "New York, NV, 10013"，包裹会延误或退回。邮编首位数字对应固定的几个州（USPS 国家分区），拦得住选错州
describe('邮编与州对得上（zipMatchesState）', () => {
  it('🔴 首位数字与州不符 → 报在邮编上，说清是哪个州', () => {
    const r = formErrors({ ...formModel(ADDR), state: 'NV', postal_code: '10013' });
    expect(r.errors.postal_code).toBe('邮编 10013 不属于 Nevada（NV）——请检查州或邮编');
  });

  it('对得上的不拦；例外照顾到（宁可少拦，不误拦合法地址）', () => {
    for (const [state, zip] of [
      ['NY', '10013'],
      ['NY', '06390'], // Fishers Island，纽约州却用 0 开头
      ['TX', '88510'], // El Paso，得州却用 8 开头
      ['CA', '94105-1234'],
      ['PR', '00901'],
      ['AE', '09021'],
      ['AP', '96205'],
      ['AA', '34001'],
      ['DC', '20500'],
    ] as const) {
      expect(zipMatchesState(zip, state), `${state} ${zip}`).toBe(true);
    }
    expect(zipMatchesState('10013', 'NV')).toBe(false);
    expect(zipMatchesState('90210', 'NY')).toBe(false);
  });
});

// 全入口点击测试 2026-10-11：表挪到 shared 给后台用；小程序运行时引不了 shared 包，留副本——两份必须逐项相同
describe('ZIP_AREA_STATES 与 shared 同一份', () => {
  it('🔴 逐项相同（漂移就红）', async () => {
    const shared = await import('@waselect/shared');
    const mine = await import('./address-form.js');
    expect(mine.ZIP_AREA_STATES).toEqual(shared.ZIP_AREA_STATES);
  });
});
