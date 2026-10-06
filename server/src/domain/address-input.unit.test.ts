/**
 * 职责：`domain/address-input.ts`（地址形状与格式校验）的单测（I2 U-B2c）。
 *
 * @why 这份校验有两个消费方（买家地址簿 CRUD、管理端改址），所以它的用例是**共享的**守护：
 *      改邮编规则只改一处代码，但两条链路同时被这批用例保护。
 *
 * @why 每条格式规则都给"错"和"对"两个值（不是只给错的）：只断言"错的被拒"时，
 *      把正则写反（例如 `^[0-9]{5}$` 写成 `[^0-9]{5}`）会连正确值一起拒掉——
 *      而用例照样绿。守"放行"和守"拒绝"是两件事，缺一个就等于没守。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseAddressInput } from './address-input.js';
import {
  US_ADDRESSES,
  US_ADDRESS_INVALID,
  formatUsPhone,
} from '../../../test/factories/catalog.js';

const OK_ADDR = {
  recipient: 'Jane Doe',
  phone: '+14155552671',
  line1: '1 Infinite Loop',
  city: 'Cupertino',
  state: 'CA',
  postal_code: '95014',
};

/** 取错误码与 reason（断言 reason 时先确认它确实是 AppError，避免 undefined 假绿）。 */
function fail(body: unknown): { code: number; reason?: string; field?: string } {
  try {
    parseAddressInput(body);
  } catch (e) {
    const err = e as AppError;
    expect(err).toBeInstanceOf(AppError);
    return {
      code: err.code,
      ...((err.details as { reason?: string; field?: string } | undefined) ?? {}),
    };
  }
  throw new Error('期望被拒，实际通过');
}

describe('address-input（地址校验，I2 U-B2c）', () => {
  it('合法输入原样返回：country 默认 US、line2 缺失为 null、is_default 默认 false', () => {
    const v = parseAddressInput({ ...OK_ADDR });
    expect(v.recipient).toBe('Jane Doe');
    expect(v.line2).toBeNull();
    expect(v.country).toBe('US');
    expect(v.is_default).toBe(false);
    expect(parseAddressInput({ ...OK_ADDR, country: 'CA', is_default: true }).country).toBe('CA');
  });

  it('六个必填字段逐个缺失 → 40001 且 reason 点名字段', () => {
    for (const k of ['recipient', 'phone', 'line1', 'city', 'state', 'postal_code']) {
      const body: Record<string, unknown> = { ...OK_ADDR };
      delete body[k];
      expect(fail(body).code).toBe(40001);
      expect(fail(body).reason).toBe(`${k}_required`);
    }
  });

  it('空串 / 非字符串 → 40001（不是 40002：那是"形状"不是"格式"）', () => {
    expect(fail({ ...OK_ADDR, recipient: '' }).code).toBe(40001);
    expect(fail({ ...OK_ADDR, city: 123 }).code).toBe(40001);
    expect(fail(null).reason).toBe('body_shape');
    expect(fail('not an object').reason).toBe('body_shape');
  });

  it('超列宽 → 40001 *_too_long（DB 兜底之前的形状错）', () => {
    const long = (n: number) => 'x'.repeat(n);
    expect(fail({ ...OK_ADDR, recipient: long(101) }).reason).toBe('recipient_too_long');
    expect(fail({ ...OK_ADDR, phone: long(21) }).reason).toBe('phone_too_long');
    expect(fail({ ...OK_ADDR, line1: long(201) }).reason).toBe('line1_too_long');
    expect(fail({ ...OK_ADDR, line2: long(201) }).reason).toBe('line2_too_long');
    expect(fail({ ...OK_ADDR, city: long(101) }).reason).toBe('city_too_long');
    expect(fail({ ...OK_ADDR, postal_code: long(11) }).reason).toBe('postal_code_too_long');
    // 反向：恰好等于列宽要放行（off-by-one 只在这一侧能抓到）
    expect(parseAddressInput({ ...OK_ADDR, recipient: long(100) }).recipient).toHaveLength(100);
  });

  it('收件人 / 街道 / 城市非 ASCII → 40002（须英文或拼音）', () => {
    expect(fail({ ...OK_ADDR, recipient: '张三' }).field).toBe('recipient');
    expect(fail({ ...OK_ADDR, line1: '北京市朝阳区' }).field).toBe('line1');
    expect(fail({ ...OK_ADDR, city: '東京' }).field).toBe('city');
    // 拼音是允许的（这是"跨境直邮"的实际写法）
    expect(parseAddressInput({ ...OK_ADDR, recipient: 'ZHANG SAN' }).recipient).toBe('ZHANG SAN');
  });

  it('line2：非 ASCII 拒，空串与缺失都放行（可空字段不等于必填）', () => {
    expect(fail({ ...OK_ADDR, line2: '号楼' }).field).toBe('line2');
    expect(parseAddressInput({ ...OK_ADDR, line2: '' }).line2).toBe('');
    expect(parseAddressInput({ ...OK_ADDR, line2: null }).line2).toBeNull();
    expect(parseAddressInput({ ...OK_ADDR, line2: 'Apt 3B' }).line2).toBe('Apt 3B');
  });

  it('电话须 +1 开头共 12 位；少一位 / 缺 +1 / 带分隔符都拒', () => {
    expect(fail({ ...OK_ADDR, phone: '+1415555267' }).field).toBe('phone');
    expect(fail({ ...OK_ADDR, phone: '4155552671' }).field).toBe('phone');
    expect(fail({ ...OK_ADDR, phone: '+1-415-555-2671' }).field).toBe('phone');
    expect(parseAddressInput({ ...OK_ADDR }).phone).toBe('+14155552671');
  });

  it('🔴 美国地址的 state 必须在 USPS 州码白名单里（剩余清单 4-5）：XX 拒；DC / PR / AE 收', () => {
    expect(fail({ ...OK_ADDR, state: 'XX' }).field).toBe('state');
    expect(fail({ ...OK_ADDR, state: 'UM' }).field).toBe('state');
    for (const st of ['DC', 'PR', 'AE'])
      expect(() => parseAddressInput({ ...OK_ADDR, state: st })).not.toThrow();
  });

  it('state 须两个大写字母（小写 / 一位 / 三位都拒）', () => {
    expect(fail({ ...OK_ADDR, state: 'ca' }).field).toBe('state');
    expect(fail({ ...OK_ADDR, state: 'C' }).field).toBe('state');
    expect(fail({ ...OK_ADDR, state: 'CAL' }).field).toBe('state');
    expect(parseAddressInput({ ...OK_ADDR, state: 'NY' }).state).toBe('NY');
  });

  it('邮编 5 位或 ZIP+4；4 位 / 6 位 / 连字符后不足 4 位都拒', () => {
    expect(fail({ ...OK_ADDR, postal_code: '9501' }).field).toBe('postal_code');
    expect(fail({ ...OK_ADDR, postal_code: '950144' }).field).toBe('postal_code');
    expect(fail({ ...OK_ADDR, postal_code: '95014-123' }).field).toBe('postal_code');
    expect(parseAddressInput({ ...OK_ADDR, postal_code: '95014-1234' }).postal_code).toBe(
      '95014-1234',
    );
  });

  // @why 这条钉住"本文件不查库"的边界：国家能不能下单由路由层查 country_profiles，
  //      本函数对任何字符串都放行。若哪天有人把国家校验挪进来，这条会红——
  //      那时就要重新讨论"纯函数"这个性质还要不要。
  it('不校验国家：任意 country 都放行（国家归路由层表驱动）', () => {
    expect(parseAddressInput({ ...OK_ADDR, country: 'ZZ' }).country).toBe('ZZ');
  });
});

/**
 * 形态清单的样本池接进应用层校验（第三轮审查 TST3-02）。
 * @why 池子（军邮 AA/AE/AP、属地 PR、PO Box、ZIP+4……）原来只喂给 DB CHECK；
 *      真正拦用户的是这里（40002）与小程序 `address-form.js`。把州码收紧成 50 州白名单
 *      （FX5 的原始形态）时，原有用例只用过 CA / NY，全绿——池子里的军邮与波多黎各会在填地址时被拒。
 * @limitation 反例池的 `expect` 是 DB 约束名；这里只断言"应用层也拒"，不比对约束名。
 */
describe('US_ADDRESSES / US_ADDRESS_INVALID 样本池（TST3-02）', () => {
  const toBody = (s: (typeof US_ADDRESSES)[number]) => ({
    recipient: s.recipient,
    phone: formatUsPhone(s.areaCode, 5_000_000),
    line1: s.line1,
    ...(s.line2 === null ? {} : { line2: s.line2 }),
    city: s.city,
    state: s.state,
    postal_code: s.postalCode,
  });

  it.each(US_ADDRESSES.map((s) => [`${s.recipient} / ${s.state} ${s.postalCode}`, s] as const))(
    '合法样本放行：%s',
    (_label, seed) => {
      expect(() => parseAddressInput(toBody(seed))).not.toThrow();
    },
  );

  it.each(US_ADDRESS_INVALID.map((c) => [c.name, c] as const))('反例被拒：%s', (_n, c) => {
    // 超长类是"形状错"（40001），其余是格式错（40002）——两者都是应用层拒绝
    expect([40001, 40002]).toContain(fail({ ...OK_ADDR, ...c.patch }).code);
  });
});

describe('🔴 必填文本：纯空白 ≠ 已填写（面单三要素）', () => {
  /**
   * @why 面单的收件人 / 街道 / 城市三个字段，原来只判 `length > 0`——
   *      敲三个空格就能通过全部校验并存进地址簿。它不会在保存时报错，
   *      也不会在地址列表里显得异常（一行看起来是空的），
   *      一直要到**打面单**或**承运商校验**那一步才炸——而那时货已经在仓里了。
   * @why 只钉这三个：`phone` / `state` / `postal_code` 有各自的格式正则
   *      （`PHONE_RE` / `^[A-Z]{2}$` / `POSTAL_RE`），纯空格**本来就会**被它们拒掉，
   *      不会静默通过；给它们补用例只会制造"这条守住了什么"的错觉。
   */
  it('recipient 为纯空格 → 40001 recipient_required', () => {
    const r = fail({ ...OK_ADDR, recipient: '   ' });
    expect(r.code).toBe(40001);
    expect(r.reason).toBe('recipient_required');
  });

  it('line1 为纯空格 → 40001 line1_required', () => {
    const r = fail({ ...OK_ADDR, line1: '   ' });
    expect(r.code).toBe(40001);
    expect(r.reason).toBe('line1_required');
  });

  it('city 为纯空格 → 40001 city_required', () => {
    const r = fail({ ...OK_ADDR, city: '　 ' });
    expect(r.code).toBe(40001);
    expect(r.reason).toBe('city_required');
  });

  /** 反向：城市名含空格是真实存在的（San Francisco / Las Vegas）。 */
  it('🔴 城市名含正常空格仍通过（不是把空格一律拒掉）', () => {
    expect(() => parseAddressInput({ ...OK_ADDR, city: 'San Francisco' })).not.toThrow();
  });
});
