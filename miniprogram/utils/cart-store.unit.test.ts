/**
 * 职责：`utils/cart-store.js` 的单测——购物车本地状态的每一种变形各有用例。
 *
 * @why 钉的都是"错了不报错"的事：
 *      ① 同商品加两次出两行 → 用户改一行数量，另一行还是旧的（看起来"改不掉"）；
 *      ② qty 减到 0 留僵尸行 → 每个"遍历购物车"的地方都要判一次 0，漏判就出幽灵商品；
 *      ③ 缓存价被拿去算合计 → 价格变了没人发现（@see cart-store.js @limitation 一）；
 *      ④ 持久化坏数据 → 整个购物车打不开 = 局部损坏放大成全部丢失。
 *
 * @see ./cart-store.js
 */
import { describe, expect, it } from 'vitest';
import { createCartStore } from './cart-store.js';
import { createStorage } from './storage.js';
import { createWxApi } from './wx-api.js';

/** 内存版 storage（真实封装 + 假宿主，不走任何 mock 层）。 */
function memStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const wx = createWxApi({
    getStorageSync: (k) => (typeof data[k] === 'string' ? data[k] : ''),
    setStorageSync: (k, v) => {
      data[k] = String(v);
    },
    removeStorageSync: (k) => {
      delete data[k];
    },
  });
  return { storage: createStorage({ wx }), data };
}

const OIL = {
  productId: 'p-shiro-cleansing-oil',
  qty: 1,
  title: '資生堂 クレンジングオイル 200ml',
  image: 'https://img.example.com/p1/card.jpg',
  priceJpy: 3600,
};

describe('add（加购与合并）', () => {
  it('新商品进一行；读出来的 items 是副本（改返回值不改购物车）', () => {
    const cart = createCartStore({ storage: memStorage().storage });
    cart.add(OIL);
    const out = cart.items();
    const first = out[0];
    if (first !== undefined) first.qty = 99;
    expect(cart.items()[0]?.qty).toBe(1);
  });

  it('⚠️ 同商品再 add → **合并数量**，不出第二行', () => {
    const cart = createCartStore({ storage: memStorage().storage });
    cart.add(OIL);
    cart.add({ ...OIL, qty: 2 });
    expect(cart.items()).toHaveLength(1);
    expect(cart.items()[0]?.qty).toBe(3);
    expect(cart.count()).toBe(3);
  });

  it('qty 缺省 = 1；qty 0 / 负数 / 非整数 / 非数字 → 抛（不是"加了但没加进去"）', () => {
    const cart = createCartStore({ storage: memStorage().storage });
    expect(() => cart.add({ productId: 'p-1' })).not.toThrow();
    for (const qty of [0, -1, 1.5, '2', Number.NaN]) {
      expect(() => cart.add({ productId: 'p-2', qty: qty as never })).toThrow(/qty/);
    }
  });

  it('productId 空 / 缺失 → 抛（空 id 的行会让"改数量"永远找不到它）', () => {
    const cart = createCartStore({ storage: memStorage().storage });
    for (const bad of [{}, { productId: '' }, null]) {
      expect(() => cart.add(bad as never)).toThrow(/productId/);
    }
  });
});

describe('setQty / remove / clear', () => {
  it('⚠️ qty 减到 0 = **移除**（不留 qty=0 的僵尸行）', () => {
    const cart = createCartStore({ storage: memStorage().storage, initial: [{ ...OIL, qty: 2 }] });
    cart.setQty(OIL.productId ?? '', 1);
    expect(cart.items()).toHaveLength(1);
    cart.setQty(OIL.productId ?? '', 0);
    expect(cart.items()).toHaveLength(0);
    cart.add(OIL);
    cart.setQty(OIL.productId ?? '', -3);
    expect(cart.items()).toHaveLength(0);
  });

  it('qty 非整数 → 抛；改不存在的条目 = 空操作（不是错误）', () => {
    const cart = createCartStore({ storage: memStorage().storage, initial: [OIL] });
    expect(() => cart.setQty(OIL.productId ?? '', 1.5)).toThrow(/整数/);
    expect(() => cart.setQty('p-ghost', 2)).not.toThrow();
    expect(cart.items()).toHaveLength(1);
  });

  it('remove 不存在的条目 = 空操作；clear 清空', () => {
    const cart = createCartStore({ storage: memStorage().storage, initial: [OIL] });
    cart.remove('p-ghost');
    expect(cart.items()).toHaveLength(1);
    cart.clear();
    expect(cart.items()).toHaveLength(0);
    expect(cart.count()).toBe(0);
  });
});

describe('toOrderItems（契约 OrderItemsInput 形状）', () => {
  it('产出 {product_id, qty}——快照字段（title/image/price）不外流', () => {
    // @why quote/建单只认 id+qty；把缓存价发给服务端等于暗示"前端价格有效"，
    //      而契约根本没有这个字段（发过去也只是被丢弃）。
    const cart = createCartStore({ storage: memStorage().storage, initial: [{ ...OIL, qty: 2 }] });
    expect(cart.toOrderItems()).toEqual([{ product_id: 'p-shiro-cleansing-oil', qty: 2 }]);
  });
});

describe('持久化（D-52）', () => {
  it('写操作后能从 storage 读回（键带 ws: 前缀）', () => {
    const { storage, data } = memStorage();
    const cart = createCartStore({ storage });
    cart.add(OIL);
    const roundTrip = JSON.parse(data['ws:cart'] ?? '[]');
    expect(roundTrip).toEqual([OIL]);
  });

  it('⚠️ 持久化坏数据 → 坏条目**丢弃**，不让整个购物车打不开', () => {
    const { storage, data } = memStorage();
    data['ws:cart'] = JSON.stringify([
      OIL,
      { productId: '', qty: 1 }, // 空 id → 丢
      { productId: 'p-2', qty: 0 }, // 僵尸行 → 丢
      'garbage', // 非对象 → 丢
      { productId: 'p-3', qty: 1.5 }, // 非整数 qty → 丢
    ]);
    const cart = createCartStore({ storage });
    expect(cart.items()).toEqual([OIL]);
  });

  it('整段 JSON 损坏（storage.getJson 兜底返回 undefined）→ 空购物车', () => {
    const { storage, data } = memStorage();
    data['ws:cart'] = '{broken json';
    const cart = createCartStore({ storage });
    expect(cart.items()).toEqual([]);
  });
});
