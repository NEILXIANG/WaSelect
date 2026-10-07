/** 开发商品图（三端联动模拟 2026-10-08）：真库 + 内存存储。 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { Db } from '../server/src/adapters/db.js';
import { createMemoryStorage } from '../server/src/adapters/storage-memory.js';
import { ensureTestDb, resetTestDb, testDb } from '../test/db/test-db.js';
import { attachDevImages, renderProductImage } from './dev-images-lib.js';

let db: Db;
beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  const { closeDb } = await import('../server/src/adapters/db.js');
  await closeDb(db);
});
beforeEach(async () => {
  await resetTestDb(db);
});

const insert = (id: string, images: unknown) => db`
  insert into products (id, title, title_ja, category, price_jpy, weight_g, stock, customs_desc_en, hs_code, origin_country, status, images)
  values (${id}, '东京香蕉蛋糕 8 个装', '東京ばな奈 8個入', 'food', 1400, 520, 10, 'Confectionery', '1905.90', 'JP', 'active', ${db.json(images as never)})`;

describe('dev-images', () => {
  it('renderProductImage 产出 1200×1200 PNG', async () => {
    const png = await renderProductImage({
      title: '中性笔',
      titleJa: 'ボールペン',
      category: 'daily',
      priceJpy: 550,
    });
    const m = await sharp(png).metadata();
    expect([m.format, m.width, m.height]).toEqual(['png', 1200, 1200]);
  });

  it('只给没图的商品配图：三档写进存储、images 写成 [{image_id}]；已有图的不动', async () => {
    await insert('p-a', []);
    await insert('p-b', [{ thumb: 'https://x/t', card: 'https://x/c', detail: 'https://x/d' }]);
    const storage = createMemoryStorage();
    expect(await attachDevImages(db, storage)).toBe(1);
    const [a] = await db`select images from products where id = 'p-a'`;
    const id = (a?.['images'] as { image_id: string }[])[0]?.image_id ?? '';
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(storage.size()).toBe(3);
    const [b] = await db`select images from products where id = 'p-b'`;
    expect(b?.['images']).toEqual([
      { thumb: 'https://x/t', card: 'https://x/c', detail: 'https://x/d' },
    ]);
    expect(await attachDevImages(db, storage)).toBe(0); // 幂等
  });
});
