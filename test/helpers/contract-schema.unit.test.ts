/**
 * 契约响应形状校验器（E-8）的单测：校验器本身错了，用它的路由用例全部是假绿灯。
 * @why 用小段内联 schema 而不是整份契约：每条用例只钉一条规则，红了能直接看出是哪条规则坏了。
 */
import { describe, expect, it } from 'vitest';
import { checkShape, contractSchema } from './contract-schema.js';

const S = {
  Card: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
      price_jpy: { type: 'integer', minimum: 0 },
      tag: { type: 'string', nullable: true, enum: ['new', 'hot', null] },
      image: { $ref: '#/components/schemas/Img' },
    },
  },
  Img: { type: 'object', properties: { url: { type: 'string' } } },
  Detail: {
    allOf: [
      { $ref: '#/components/schemas/Card' },
      {
        type: 'object',
        properties: { images: { type: 'array', items: { $ref: '#/components/schemas/Img' } } },
      },
    ],
  },
};

describe('checkShape：契约子集校验（E-8）', () => {
  it('合法 → 无问题', () => {
    expect(
      checkShape(S, 'Detail', { id: 'p1', price_jpy: 100, tag: null, images: [{ url: 'u' }] }),
    ).toEqual([]);
  });

  it.each([
    ['缺必填', { price_jpy: 1 }, '$.id 缺失'],
    ['类型不对', { id: 1 }, '$.id 应为 string'],
    ['integer 收到小数', { id: 'p', price_jpy: 1.5 }, '$.price_jpy 应为 integer'],
    ['低于 minimum', { id: 'p', price_jpy: -1 }, '$.price_jpy 小于 0'],
    ['不在 enum', { id: 'p', tag: 'old' }, '$.tag 不在枚举'],
    ['非 nullable 给了 null', { id: 'p', price_jpy: null }, '$.price_jpy 不可为 null'],
    ['$ref 内部错', { id: 'p', image: { url: 3 } }, '$.image.url 应为 string'],
    ['数组项错', { id: 'p', images: [{ url: 3 }] }, '$.images[0].url 应为 string'],
    ['契约里没有的键（改名 / 多出来的字段）', { id: 'p', imgs: [] }, '$.imgs 契约里没有'],
  ])('%s → 报出', (_n, v, msg) => {
    expect(checkShape(S, 'Detail', v).join('\n')).toContain(msg);
  });

  it('真契约可加载，四个关键 schema 都在', () => {
    const all = contractSchema();
    for (const k of ['Product', 'ProductCard', 'Order', 'OrderListItem'])
      expect(all[k], k).toBeDefined();
  });
});
