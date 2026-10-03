/**
 * 职责：`admin-web/src/orders/address-view.ts` 的单测。
 *
 * @why 钉的是**面单打不出来**这一类：地址写进订单快照之后没有第二次机会，
 *      电话少个 +1、州写成小写 ca、邮编多一位——都要到承运商那一环才现形，
 *      而那时货已经在路上了。
 *
 * @see ../../../miniprogram/utils/address-form.unit.test.ts（小程序侧同一份契约的另一半守护）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_FIELDS,
  ADDRESS_PATTERNS,
  addressFormErrors,
  addressFormModel,
  emptyAddressForm,
  toAddressInput,
} from './address-view.js';

const ORDER = {
  order_id: 'o-2609-0013',
  status: 'paid',
  address: {
    recipient: 'Emily Carter',
    phone: '+12065550123',
    line1: '500 Union St',
    line2: 'Apt 12B',
    city: 'Seattle',
    state: 'WA',
    postal_code: '98101',
  },
};

const valid = (): Record<string, string> => ({
  recipient: 'Emily Carter',
  phone: '+12065550123',
  line1: '500 Union St',
  line2: 'Apt 12B',
  city: 'Seattle',
  state: 'WA',
  postal_code: '98101',
});

describe('addressFormModel', () => {
  it('从订单的 address 逐字段预填', () => {
    expect(addressFormModel(ORDER)).toEqual({
      recipient: 'Emily Carter',
      phone: '+12065550123',
      line1: '500 Union St',
      line2: 'Apt 12B',
      city: 'Seattle',
      state: 'WA',
      postal_code: '98101',
    });
  });

  it('⚠️ 州名小写 → 归一成大写（面单上 ca 与 CA 是两个值）', () => {
    expect(addressFormModel({ address: { state: 'wa' } }).state).toBe('WA');
  });

  it('⚠️ 没有 address / 非对象 → 空表单（不是抛，也不是半截对象）', () => {
    expect(addressFormModel({})).toEqual(emptyAddressForm());
    expect(addressFormModel(null)).toEqual(emptyAddressForm());
  });

  it('字段顺序与页面一致（顺序变了表单会错位）', () => {
    expect(ADDRESS_FIELDS).toEqual([
      'recipient',
      'phone',
      'line1',
      'line2',
      'city',
      'state',
      'postal_code',
    ]);
  });
});

describe('addressFormErrors', () => {
  it('一条合法地址全过', () => {
    expect(addressFormErrors(valid()).ok).toBe(true);
  });

  it('⚠️ 电话缺 +1 → 报 phone（面单打不出来的典型）', () => {
    const r = addressFormErrors({ ...valid(), phone: '2065550123' });
    expect(r.ok).toBe(false);
    expect(r.errors['phone']).toContain('+1');
  });

  it('⚠️ 收件人写中文 → 报 recipient（美国面单不接受非 ASCII）', () => {
    const r = addressFormErrors({ ...valid(), recipient: '王小明' });
    expect(r.errors['recipient']).toBeTruthy();
  });

  it('⚠️ line2 留空是合法的（它是唯一可空的字段）', () => {
    expect(addressFormErrors({ ...valid(), line2: '' }).ok).toBe(true);
  });

  it('⚠️ line2 含中文也要报（可空 ≠ 随便填）', () => {
    expect(addressFormErrors({ ...valid(), line2: '１２Ｂ' }).errors['line2']).toBeTruthy();
  });

  it('⚠️ 邮编 ZIP+4 合法，邮编少一位不合法', () => {
    expect(addressFormErrors({ ...valid(), postal_code: '98101-1234' }).ok).toBe(true);
    expect(
      addressFormErrors({ ...valid(), postal_code: '9810' }).errors['postal_code'],
    ).toBeTruthy();
  });

  it('多个字段错 → 一起返回（不是一个一个报）', () => {
    const r = addressFormErrors({ ...valid(), phone: '', city: '', state: 'x' });
    expect(Object.keys(r.errors).sort()).toEqual(['city', 'phone', 'state']);
    expect(r.first).not.toBe('');
  });
});

describe('toAddressInput', () => {
  it('输出契约 AddressInput 的形状（含 country，不含 is_default）', () => {
    expect(toAddressInput(valid())).toEqual({
      recipient: 'Emily Carter',
      phone: '+12065550123',
      line1: '500 Union St',
      line2: 'Apt 12B',
      city: 'Seattle',
      state: 'WA',
      postal_code: '98101',
      country: 'US',
    });
  });

  it('⚠️ line2 空串仍带上（删掉字段 = "清空第二行"不生效）', () => {
    expect(toAddressInput({ ...valid(), line2: '' })).toMatchObject({ line2: '' });
  });

  it('⚠️ 不带 is_default：改的是这一单寄到哪，不是用户默认地址', () => {
    expect(Object.keys(toAddressInput(valid()))).not.toContain('is_default');
  });

  it('两侧空格被 trim（" Seattle " 会让面单多两个空格）', () => {
    expect(toAddressInput({ ...valid(), city: '  Seattle  ' }).city).toBe('Seattle');
  });
});

/**
 * ⚠️ 与契约的双向比对：前端正则的 `source` 必须等于 yaml 里的 pattern 字符串。
 * @why 这是"两处真值"的缝合线（管理端与小程序各一份，都以契约为真源）。
 *      缺了它，改了契约不改前端的表现是"前端校验全过、服务端 40001"。
 */
describe('与契约 AddressInput 的双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../../contracts/api-contract.yaml'), 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('AddressInput:')) ?? '';

  const ENTRIES: Array<[string, keyof typeof ADDRESS_PATTERNS]> = [
    ['recipient', 'ascii'],
    ['phone', 'phone'],
    ['line1', 'ascii'],
    ['line2', 'asciiOptional'],
    ['city', 'ascii'],
    ['postal_code', 'postal'],
  ];

  it('抽到了 AddressInput 那一行（契约改写成多行会失配）', () => {
    expect(line).toContain('AddressInput');
    expect(line).toContain('pattern');
  });

  // 0.6.27（契约批次）：契约给各字段补了 `maxLength`，字段对象里的**键顺序不再固定**——
  // 旧写法把 `{type: string, pattern: …}` 写死，加一个键就整条失配。
  // 改成 `[^}]*` 跳过该字段对象内的其它键（与 miniprogram/utils/address-form 同口径，
  // ⚠️ 这两处是**同一判据的两份拷贝**，改契约时要一起改）。
  it.each(ENTRIES)('字段 %s 的 pattern 与前端正则一致', (field, key) => {
    const m = new RegExp(`${field}: \\{[^}]*pattern: '([^']+)'`).exec(line);
    expect(m?.[1], `契约里没找到 ${field} 的 pattern`).toBeTruthy();
    expect(ADDRESS_PATTERNS[key].source).toBe(m?.[1]);
  });

  it('州：契约约束长度 2（大小写由本模块归一）', () => {
    expect(/state: \{[^}]*minLength: 2[^}]*maxLength: 2/.exec(line)?.[0]).toBeTruthy();
    expect(ADDRESS_PATTERNS.state.source).toBe('^[A-Z]{2}$');
  });
});
