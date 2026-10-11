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
import { MAX_QUOTE_ITEMS } from '../../server/src/domain/quote.js';
import { MAX_CART_LINES, MAX_LINE_QTY, createCartStore } from './cart-store.js';
import { MAX_LINE_QTY as SHARED_MAX_LINE_QTY } from '@waselect/shared';
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

describe('syncPrices（契约 0.6.39 Quote.lines；三端联动模拟 2026-10-08）', () => {
  it('🔴 报价里的当前单价覆盖加购时的快照价并落盘；没变 / 脏行 / 不在车里的 → 不动', () => {
    const disk = new Map<string, unknown>();
    const storage = {
      getJson: (k: string) => disk.get(k) ?? null,
      setJson: (k: string, v: unknown) => void disk.set(k, JSON.parse(JSON.stringify(v))),
    };
    const cart = createCartStore({ storage } as never);
    cart.add({ productId: 'p-1', title: '香蕉蛋糕', image: '', priceJpy: 1400 } as never);
    cart.add({ productId: 'p-2', title: '抹茶', image: '', priceJpy: 2380 } as never);
    expect(
      cart.syncPrices([
        { product_id: 'p-1', unit_price_jpy: 1600 },
        { product_id: 'p-2', unit_price_jpy: 2380 },
        { product_id: 'p-x', unit_price_jpy: 1 },
        { product_id: 'p-2', unit_price_jpy: -5 },
        null,
      ]),
    ).toBe(true);
    expect(cart.items().map((i) => (i as { priceJpy?: number }).priceJpy)).toEqual([1600, 2380]);
    expect(JSON.stringify(disk.get([...disk.keys()][0] as string))).toContain('1600');
    expect(cart.syncPrices([{ product_id: 'p-1', unit_price_jpy: 1600 }])).toBe(false);
    expect(cart.syncPrices(undefined)).toBe(false);
  });
});

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
    // A3（AJ-416）起每条多落一个勾选状态
    expect(roundTrip).toEqual([{ ...OIL, selected: true }]);
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
    expect(cart.items()).toEqual([{ ...OIL, selected: true }]);
  });

  it('整段 JSON 损坏（storage.getJson 兜底返回 undefined）→ 空购物车', () => {
    const { storage, data } = memStorage();
    data['ws:cart'] = '{broken json';
    const cart = createCartStore({ storage });
    expect(cart.items()).toEqual([]);
  });
});

describe('品种上限（P2-31：报价端 >50 行一律 40001）', () => {
  /** 造 n 个不同商品的条目。 */
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      productId: `p-${String(i)}`,
      qty: 1,
      title: `商品${String(i)}`,
    }));

  it('上限与服务端 MAX_QUOTE_ITEMS 同值（漂移即红）', () => {
    expect(MAX_CART_LINES).toBe(MAX_QUOTE_ITEMS);
  });

  it('第 51 种商品加不进去：返回 full，购物车不变、不落盘', () => {
    const { storage, data } = memStorage();
    const cart = createCartStore({ storage, initial: lines(MAX_CART_LINES) });
    const before = data['ws:cart'];
    const r = cart.add({ productId: 'p-new', qty: 1 });
    expect(r).toEqual({ added: false, reason: 'full' });
    expect(cart.items()).toHaveLength(MAX_CART_LINES);
    expect(data['ws:cart']).toBe(before);
  });

  it('满 50 种时给已有商品加数量仍可以（上限只管品种数，不管件数）', () => {
    const { storage } = memStorage();
    const cart = createCartStore({ storage, initial: lines(MAX_CART_LINES) });
    expect(cart.add({ productId: 'p-0', qty: 2 })).toEqual({ added: true });
    expect(cart.items()[0]?.qty).toBe(3);
  });

  it('正常加购返回 added: true', () => {
    const { storage } = memStorage();
    const cart = createCartStore({ storage });
    expect(cart.add(OIL)).toEqual({ added: true });
  });
});

describe('restore（撤销删除放回原位，M-14 / AJ-406）', () => {
  const KNIFE = {
    productId: 'p-sakai-gyuto-210',
    qty: 1,
    title: '堺孝行 牛刀 210mm',
    image: 'https://img.example.com/p2/card.jpg',
    priceJpy: 18_700,
  };
  const TEA = {
    productId: 'p-uji-matcha-40g',
    qty: 2,
    title: '宇治抹茶 40g',
    image: '',
    priceJpy: 2_160,
  };

  it('🔴 删中间一行再 restore → 回到原下标（不是末尾），快照价原样，并落盘', () => {
    const { storage, data } = memStorage();
    const cart = createCartStore({ storage });
    cart.add(OIL);
    cart.add(KNIFE);
    cart.add(TEA);
    const before = cart.items();
    cart.remove(KNIFE.productId);
    expect(cart.restore(before[1]!, 1)).toBe(true);
    expect(cart.items()).toEqual(before);
    expect(JSON.parse(data['ws:cart'] ?? '[]')).toEqual(before);
  });

  it('撤销窗口内同商品又被加进来 → 合并数量，不出第二行', () => {
    const cart = createCartStore({ storage: memStorage().storage });
    cart.add(OIL);
    cart.remove(OIL.productId);
    cart.add({ ...OIL, qty: 1 });
    expect(cart.restore({ ...OIL, qty: 2 }, 0)).toBe(true);
    expect(cart.items()).toHaveLength(1);
    expect(cart.items()[0]?.qty).toBe(3);
  });

  it('下标越界 / 非整数 → 放到末尾；脏条目 → false 不动', () => {
    const cart = createCartStore({ storage: memStorage().storage });
    cart.add(OIL);
    expect(cart.restore(TEA, 99)).toBe(true);
    expect(cart.restore(KNIFE, Number.NaN)).toBe(true);
    expect(cart.items().map((i) => i.productId)).toEqual([
      OIL.productId,
      TEA.productId,
      KNIFE.productId,
    ]);
    expect(cart.restore({ ...OIL, qty: 0 }, 0)).toBe(false);
    expect(cart.restore(null as never, 0)).toBe(false);
  });
});

describe('持久化读回去重（审查 2026-10-09）', () => {
  it('🔴 存储里同一商品两行（旧版本 / 损坏）→ 合并成一行、数量相加；toOrderItems 不再带重复 product_id', () => {
    const { storage, data } = memStorage();
    storage.setJson('cart', [
      { productId: 'p-1', qty: 1, title: 'A', image: '', priceJpy: 100 },
      { productId: 'p-1', qty: 2, title: 'A', image: '', priceJpy: 100 },
      { productId: 'p-2', qty: 1, title: 'B', image: '', priceJpy: 200 },
    ]);
    void data;
    const cart = createCartStore({ storage });
    expect(cart.toOrderItems()).toEqual([
      { product_id: 'p-1', qty: 3 },
      { product_id: 'p-2', qty: 1 },
    ]);
  });
});

describe('勾选结算（A3，AJ-416）', () => {
  const KNIFE = {
    productId: 'p-knife-210mm',
    qty: 1,
    title: '堺孝行 柳刃包丁 210mm',
    image: '',
    priceJpy: 18000,
  };

  it('🔴 默认全选；取消勾选的不进报价 / 建单的 items；勾选状态落盘，重开购物车还在', () => {
    const { storage } = memStorage();
    const cart = createCartStore({ storage });
    cart.add(OIL);
    cart.add(KNIFE);
    expect(cart.selectedCount()).toBe(2);
    cart.setSelected(KNIFE.productId, false);
    expect(cart.toOrderItems()).toEqual([{ product_id: OIL.productId, qty: 1 }]);
    expect(cart.selectedCount()).toBe(1);
    // 角标仍按全部件数（没勾的也还在车里）
    expect(cart.count()).toBe(2);
    const reopened = createCartStore({ storage });
    expect(reopened.items().map((i) => i.selected)).toEqual([true, false]);
  });

  it('全选 / 全不选；再次加购同一件 → 自动勾上（用户刚表示要它）', () => {
    const { storage } = memStorage();
    const cart = createCartStore({ storage });
    cart.add(OIL);
    cart.add(KNIFE);
    cart.setAllSelected(false);
    expect(cart.toOrderItems()).toEqual([]);
    cart.add({ ...KNIFE, qty: 1 });
    expect(cart.toOrderItems()).toEqual([{ product_id: KNIFE.productId, qty: 2 }]);
    cart.setAllSelected(true);
    expect(cart.selectedCount()).toBe(2);
  });

  it('🔴 下单后只移除买走的那几件（removeMany），没勾的留在车里', () => {
    const { storage } = memStorage();
    const cart = createCartStore({ storage });
    cart.add(OIL);
    cart.add(KNIFE);
    cart.setSelected(KNIFE.productId, false);
    cart.removeMany([OIL.productId]);
    expect(cart.items().map((i) => i.productId)).toEqual([KNIFE.productId]);
  });

  it('旧版本存下的条目没有勾选字段 → 按已勾选读（升级后购物车不会突然一件都没选）', () => {
    const { storage } = memStorage({ 'ws:cart': JSON.stringify([{ productId: 'p-1', qty: 2 }]) });
    const cart = createCartStore({ storage });
    expect(cart.items()[0]?.selected).toBe(true);
    expect(cart.toOrderItems()).toEqual([{ product_id: 'p-1', qty: 2 }]);
  });

  it('🔴 单行数量封顶 MAX_LINE_QTY（AJ-448）：add 合并超过上限 → 停在上限；setQty 超上限 → 上限', () => {
    const c = createCartStore(memStorage());
    c.add({ productId: 'p-1', qty: 60 });
    c.add({ productId: 'p-1', qty: 60 });
    expect(c.items()[0]?.qty).toBe(MAX_LINE_QTY);
    c.setQty('p-1', 500);
    expect(c.items()[0]?.qty).toBe(MAX_LINE_QTY);
    // 小程序运行时进不了 shared（纯 JS），常量各存一份，由这里钉住同值
    expect(MAX_LINE_QTY).toBe(SHARED_MAX_LINE_QTY);
  });
});
