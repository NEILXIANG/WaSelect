/**
 * 职责：`country_profiles` 行解析的纯函数用例（F11 单元④，L0 层、不连库）。
 *
 * @why 这一组测的是"库里那一行 JSONB 变成对象的那一刻"——它是**配置数据进入进程唯一的门**。
 *      门这里不设防，后面所有按国家分支的逻辑（地址校验、展示币、承运商）都会拿到半截对象，
 *      而 zod 默认的 strip 行为会让"字段名拼错"变成静默的 undefined（F3 @limitation 一同款坑）。
 * @why 每条断言都检查**错误信息里带 code 或字段路径**：国家档案是运营手工改的数据，
 *      报错时如果只有"数据非法"，排查的人得去翻库猜是哪一行。可定位是这里的第一要求。
 *
 * @see server/src/adapters/country-profiles.ts（被测）；migrations/007_country_profiles.sql（数据来源）；
 *      country-profiles.db.test.ts（真库侧：种子、CHECK 约束、与 addresses 列的同源比对）
 */
import { describe, expect, it } from 'vitest';
import { compilePattern, parseCountryProfileRow, type CountryProfile } from './country-profiles.js';

/** 一条合法行。每个用例只改自己关心的那一处，避免"顺手改坏了别处"造成的假红。 */
function row(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: 'US',
    active: true,
    display_currencies: ['CNY', 'USD'],
    address_template: {
      fields: [{ key: 'city', label: '城市', required: true, maxLength: 100, pattern: '^[ -~]+$' }],
    },
    phone_pattern: '^\\+1[0-9]{10}$',
    postal_pattern: '^[0-9]{5}(-[0-9]{4})?$',
    allowed_carriers: [],
    blocked_tags: [],
    duty_note: '价格已含关税与运费（DDP）',
    ...overrides,
  };
}

function parse(overrides: Record<string, unknown> = {}): CountryProfile {
  return parseCountryProfileRow(row(overrides));
}

/**
 * 断言"抛了 Error 且消息含某片段"，并返回消息供二次断言。
 * @why 手写 try/catch 而不是 `expect(...).toThrow(fn)`：toThrow 的谓词形式拿不到消息，
 *      而"消息里到底写了什么"正是这一组用例要钉的东西（可定位性）。
 *      没抛错时 `thrown` 是 undefined → 第一条断言即红，不会静默通过。
 */
function expectThrow(overrides: Record<string, unknown>, contains: string): string {
  let thrown: unknown;
  try {
    parse(overrides);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toContain(contains);
  return message;
}

describe('parseCountryProfileRow — 正路径', () => {
  it('把 snake_case 行映射成 camelCase 对象，嵌套模板原样带出', () => {
    const p = parse();
    expect(p.code).toBe('US');
    expect(p.active).toBe(true);
    expect(p.displayCurrencies).toEqual(['CNY', 'USD']);
    expect(p.addressTemplate.fields[0]?.key).toBe('city');
    expect(p.phonePattern).toBe('^\\+1[0-9]{10}$');
    expect(p.postalPattern).toBe('^[0-9]{5}(-[0-9]{4})?$');
    expect(p.allowedCarriers).toEqual([]);
    expect(p.blockedTags).toEqual([]);
    expect(p.dutyNote).toContain('DDP');
  });

  it('未知键被静默丢弃而不是报错（zod strip，与 F3 同款行为）', () => {
    // @why 记下这条行为而不是"修掉"它：多 SELECT 一列（比如将来加了 sort）不该让读取失败。
    //      代价是拼错的列名不会报错——由 db 层的"少列即红"从另一侧兜住。
    const p = parse({ sort: 3, typo_currencies: ['JPY'] });
    expect(p.code).toBe('US');
    expect(Object.keys(p)).not.toContain('sort');
  });

  it('字段没有 pattern 时不校验正则（undefined 是合法形态）', () => {
    const p = parse({
      address_template: { fields: [{ key: 'state', label: '州', required: true, maxLength: 2 }] },
    });
    expect(p.addressTemplate.fields[0]?.pattern).toBeUndefined();
  });
});

describe('parseCountryProfileRow — 结构校验', () => {
  it('code 不是两位大写字母 → 抛，且消息带上这个值', () => {
    expectThrow({ code: 'us' }, 'country_profiles 行非法');
    expectThrow({ code: 'USA' }, 'country_profiles 行非法');
  });

  it('display_currencies 含非枚举币种 → 抛', () => {
    // @why 币种写错不会报错，只会让前端显示一个错误符号——这是"静默但看得见"的贵错误。
    expectThrow({ display_currencies: ['XXX'] }, 'display_currencies');
  });

  it('地址模板字段为空数组 → 抛', () => {
    expectThrow({ address_template: { fields: [] } }, 'address_template');
  });

  it('字段 key 重复 → 抛，且消息点名是哪个 key', () => {
    // @why 两个同名 key 会让前端渲染出两个同名输入框、值互相覆盖，而 JSON 完全合法、schema 也过得去。
    const message = expectThrow(
      {
        address_template: {
          fields: [
            { key: 'state', label: '州', required: true },
            { key: 'state', label: '州别称', required: false },
          ],
        },
      },
      'key 重复',
    );
    expect(message).toContain('state');
  });

  it('maxLength 非正整数 → 抛', () => {
    expectThrow(
      {
        address_template: {
          fields: [{ key: 'city', label: '城市', required: true, maxLength: 0 }],
        },
      },
      'address_template',
    );
  });

  it('传 null → 抛，且根级 issue 显示为 (根) 而不是空字符串', () => {
    // @why 空 path 拼出来是空字符串，"哪个字段坏了"这一栏就空着——日志里最难读的一种。
    expect(() => parseCountryProfileRow(null)).toThrow(/\(根\)/);
  });
});

describe('compilePattern — 正则试编译', () => {
  it('合法正则原样返回', () => {
    expect(compilePattern('^[0-9]{5}$', 'postal_pattern', 'US')).toBe('^[0-9]{5}$');
  });

  it('空 pattern → 抛（它匹配一切，等于不校验）', () => {
    expect(() => compilePattern('   ', 'phone_pattern', 'US')).toThrow(/匹配一切/);
  });

  it('非法正则 → 抛，且消息含国家码与字段名', () => {
    expect(() => compilePattern('(', 'phone_pattern', 'US')).toThrow(/country_profiles\[US\]/);
    expect(() => compilePattern('(', 'phone_pattern', 'US')).toThrow(/phone_pattern/);
  });

  it('顶层 phone/postal pattern 非法 → 读取即抛，不让坏数据活到用户请求里', () => {
    expectThrow({ phone_pattern: '[' }, 'phone_pattern');
    expectThrow({ postal_pattern: '(' }, 'postal_pattern');
  });

  it('模板内某个字段的 pattern 非法 → 抛，消息点名该字段', () => {
    const message = expectThrow(
      {
        address_template: {
          fields: [{ key: 'city', label: '城市', required: true, pattern: '(' }],
        },
      },
      'country_profiles[US]',
    );
    expect(message).toContain('address_template.city');
  });

  it('模板内字段 pattern 为空串 → 抛（不是"该字段免校验"）', () => {
    expectThrow(
      {
        address_template: { fields: [{ key: 'city', label: '城市', required: true, pattern: '' }] },
      },
      'address_template.city',
    );
  });
});

describe('错误信息形态（日志可定位，ADR-29）', () => {
  it('所有错误都是单行：不含换行与回车', () => {
    // @why 多行消息进结构化日志会把一条记录切成两条（pino 按行写），
    //      第二条没有 trace_id，检索时像是"凭空冒出来的一行"。
    const badInputs: Array<Record<string, unknown>> = [
      { code: 'us' },
      { display_currencies: ['XXX'] },
      { address_template: { fields: [] } },
      { phone_pattern: '' },
      { postal_pattern: '(' },
    ];
    for (const bad of badInputs) {
      const message = expectThrow(bad, 'country_profiles');
      expect(message).not.toMatch(/[\r\n]/);
    }
  });

  it('超长 issue 列表被截断，不会撑爆日志行', () => {
    // 造 20 个非法字段，每个都报一条 issue
    const fields = Array.from({ length: 20 }, (_, i) => ({
      key: 'f',
      label: `字段-${i}`,
      required: 'not-a-boolean',
    }));
    const message = expectThrow({ address_template: { fields } }, 'country_profiles');
    expect(message.length).toBeLessThan(600);
  });
});
