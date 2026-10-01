/**
 * 职责：本地盘对象存储（ObjectStorage 端口的开发期驱动，I2 U-I3）。
 *
 * @why R2 凭据在公司登记链后面（6–10 周），开发期要能看到"上传 → 文件在 →
 *      管理端能预览"的完整链路；本地盘 + 静态路由（IMG_BASE_URL 指向本机）是唯一
 *      不依赖外部凭据的答案。
 *
 * @why key 在**本适配器内**再校验一次（白名单字符 + 拒 `..` / 绝对路径 / 反斜杠）：
 *      正常 key 只来自 `imageObjectKey`（id 已校验），但适配器的职责边界是
 *      "给我什么 key 都写不穿 rootDir"——写穿的表现是把字节落进任意路径，
 *      且没有任何一方报错（与 D-46 同类：错了还静默）。
 *
 * @limitation 一：`contentType` **被丢弃**（端口 @limitation 二已声明分档）：
 *              开发期静态服务按扩展名猜。生产驱动（S3/R2）必须存元数据。
 * @limitation 二：Render 的盘是**易失**的（实例重启即丢）——本驱动仅限本地开发，
 *              生产配置里出现它属于配置事故（config 层写明）。
 *
 * @see ports/storage.ts（端口语义）
 */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ObjectStorage } from '../ports/storage.js';
import { assertSafeObjectKey } from './object-key.js';

export function createFsStorage(rootDir: string): ObjectStorage {
  // ⚠️ 用 `resolve` 而**不是** `normalize` 拼根（PAY3-05）：
  //    `normalize` **保留尾斜杠**——`normalize('/tmp/up/')` 仍是 `/tmp/up/`，
  //    再 `+ sep` 就变成 `/tmp/up//`；而 `normalize(join(root, key))` 会折叠成 `/tmp/up/x.webp`，
  //    `startsWith` 永远为假 ⇒ **每一次上传都被判"路径不安全"**（错误是 `object_key_unsafe`，
  //    排障方向会被带去查 key，而 key 是好的）。`rootDir` 写成 `.` 时同理（前缀变成 `./`）。
  //    `resolve` 同时做两件事：转绝对路径 + 去掉尾斜杠与 `.` 段。
  //    尾部分隔符仍要留：/root/evil 不以 "/root/" 开头，/root/x 才以它开头。
  const root = resolve(rootDir) + sep;
  return {
    async put(key, bytes, _contentType) {
      assertSafeObjectKey(key);
      const full = resolve(root, key);
      if (!full.startsWith(root)) throw new Error(`object_key_unsafe`);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, bytes);
    },
    async delete(key) {
      assertSafeObjectKey(key);
      const full = resolve(root, key);
      if (!full.startsWith(root)) throw new Error(`object_key_unsafe`);
      try {
        await unlink(full);
      } catch (e) {
        // 幂等：不存在不是错误（@measured node 22：unlink 缺文件抛 code === 'ENOENT'）
        if ((e as { code?: string }).code !== 'ENOENT') throw e;
      }
    },
  };
}
