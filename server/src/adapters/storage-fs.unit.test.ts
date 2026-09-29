/**
 * 职责：`adapters/storage-fs.ts`（本地盘对象存储，开发期驱动）的单测（I2 U-I3）。
 *
 * @why 读回一律走 `node:fs`（独立读取方）——适配器自己再提供一个 read 来断言是自证
 *      （§2 第 21 条）；落没落盘、落在哪，只有文件系统自己说了算。
 * @why 路径穿越用例是**安全断言**不是功能断言：key 正常只来自 `imageObjectKey`（已校验 id），
 *      这里的拦截是"将来有人把外部输入接进 put"时的最后一道——
 *      写穿 rootDir 的表现是把字节写进任意路径，且**没有任何一方报错**。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsStorage } from './storage-fs.js';

let dir = '';
async function freshRoot(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'waselect-fs-'));
  return dir;
}
afterEach(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('fs storage（开发期 ObjectStorage）', () => {
  it('put → 文件落在 rootDir/key，字节一致（node:fs 独立读回）', async () => {
    const root = await freshRoot();
    const s = createFsStorage(root);
    const bytes = Buffer.from([9, 8, 7, 6]);
    await s.put('img/abc/thumb.webp', bytes, 'image/webp');
    expect(await readFile(join(root, 'img/abc/thumb.webp'))).toEqual(bytes);
  });

  it('嵌套目录自动创建（img/{id}/ 两级不预建）', async () => {
    const root = await freshRoot();
    const s = createFsStorage(root);
    await s.put('a/b/c/d.webp', Buffer.from([1]), 'image/webp');
    expect(await readFile(join(root, 'a/b/c/d.webp'))).toEqual(Buffer.from([1]));
  });

  it('同 key 覆写：后写覆盖先写', async () => {
    const root = await freshRoot();
    const s = createFsStorage(root);
    await s.put('img/a/t.webp', Buffer.from([1]), 'image/webp');
    await s.put('img/a/t.webp', Buffer.from([2]), 'image/webp');
    expect(await readFile(join(root, 'img/a/t.webp'))).toEqual(Buffer.from([2]));
  });

  it('路径穿越 key 一律拒且**零落盘**：`..` / 绝对路径 / 反斜杠 / 中段 `..`', async () => {
    const root = await freshRoot();
    const s = createFsStorage(root);
    for (const bad of [
      '../escape.webp',
      '/abs/x.webp',
      'a\\b.webp',
      'a/../b.webp',
      '..',
      'a//b.webp',
    ]) {
      await expect(s.put(bad, Buffer.from([1]), 'image/webp')).rejects.toThrow();
    }
    // 根目录必须还是空的：任何一个漏拦都会在盘上留东西
    expect(await readdir(root)).toEqual([]);
  });

  it('合法但少见的 key 放行：连字符 / 下划线 / 多级目录', async () => {
    const root = await freshRoot();
    const s = createFsStorage(root);
    await s.put('img/018f3c2a-7b1d-7e5f/x_y-z.webp', Buffer.from([5]), 'image/webp');
    expect(await readFile(join(root, 'img/018f3c2a-7b1d-7e5f/x_y-z.webp'))).toEqual(
      Buffer.from([5]),
    );
  });
  it('delete：文件被删；再删一次不抛（ENOENT 视为已删）；穿越 key 一律拒', async () => {
    const root = await freshRoot();
    const s = createFsStorage(root);
    await s.put('img/a/detail.webp', Buffer.from('x'), 'image/webp');
    await s.delete('img/a/detail.webp');
    await expect(stat(join(root, 'img/a/detail.webp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(s.delete('img/a/detail.webp')).resolves.toBeUndefined();
    await expect(s.delete('../escape.webp')).rejects.toThrow('object_key_unsafe');
  });
});
