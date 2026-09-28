/**
 * 职责：`adapters/storage-memory.ts`（内存对象存储，测试/e2e 驱动）的单测（I2 U-I3）。
 *
 * @why 内存适配器是上传路由在测试里的替身——它自己的语义（按 key 存取、覆写、隔离）
 *      必须先钉死，否则"路由测试挂了"时分不清是路由错还是替身错。
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from './storage-memory.js';

describe('memory storage（ObjectStorage 端口替身）', () => {
  it('put → get 读回同一份字节与 contentType', async () => {
    const s = createMemoryStorage();
    const bytes = Buffer.from([1, 2, 3]);
    await s.put('img/abc/thumb.webp', bytes, 'image/webp');
    expect(s.get('img/abc/thumb.webp')).toEqual({ bytes, contentType: 'image/webp' });
  });

  it('未 put 的 key → undefined（不是 throw，不是空 Buffer）', () => {
    const s = createMemoryStorage();
    expect(s.get('img/none/x.webp')).toBeUndefined();
  });

  it('同 key 覆写：后写覆盖先写（重复上传同一 id 不该报错）', async () => {
    const s = createMemoryStorage();
    await s.put('img/a/t.webp', Buffer.from([1]), 'image/webp');
    await s.put('img/a/t.webp', Buffer.from([2]), 'image/webp');
    expect(s.get('img/a/t.webp')?.bytes).toEqual(Buffer.from([2]));
  });

  it('key 之间互不串：两个 key 各取各的（共享前缀不是目录，Map 没有"目录"概念）', async () => {
    const s = createMemoryStorage();
    await s.put('img/a/thumb.webp', Buffer.from([1]), 'image/webp');
    await s.put('img/a/card.webp', Buffer.from([2]), 'image/webp');
    expect(s.get('img/a/thumb.webp')?.bytes).toEqual(Buffer.from([1]));
    expect(s.get('img/a/card.webp')?.bytes).toEqual(Buffer.from([2]));
    expect(s.size()).toBe(2);
  });

  it('读回的字节是**拷贝**：调用方改原 Buffer 不污染已存内容（反之亦然）', async () => {
    const s = createMemoryStorage();
    const bytes = Buffer.from([1, 2, 3]);
    await s.put('k', bytes, 'image/webp');
    bytes[0] = 99;
    expect(s.get('k')?.bytes[0]).toBe(1);
    const read = s.get('k')!;
    read.bytes[0] = 77;
    expect(s.get('k')?.bytes[0]).toBe(1);
  });
});
