/**
 * 职责：内存对象存储（ObjectStorage 端口的测试/e2e 驱动，I2 U-I3）。
 *
 * @why 测试里的上传路由需要一个"行为与真存储一致、但不碰盘不碰网"的替身；
 *      语义（覆写 / 按 key 隔离 / 字节不共享）必须与生产驱动一致，
 *      否则"路由测试挂了"时分不清是路由错还是替身错。
 *
 * @why 读写都**拷贝字节**（`Buffer.from`）：真 S3 的字节是过网序列化的，
 *      调用方之后改原 Buffer 不会影响已存内容；内存版若存引用，
 *      测试就能写出"改原 Buffer 污染存储"的代码——而它在生产会静默失效。
 *
 * @limitation 一：`get` / `size` **不在端口上**，是本驱动额外的断言面（测试用）；
 *              业务代码只许依赖 `ObjectStorage.put`。
 * @limitation 二：进程死即丢——它只是测试/e2e 驱动，不许进生产配置。
 *
 * @see ports/storage.ts（端口语义）
 */
import type { ObjectStorage } from '../ports/storage.js';

export interface MemoryStorage extends ObjectStorage {
  /** 测试断言面（非端口方法）：按 key 读回字节与 contentType 的**拷贝**。 */
  get(key: string): { bytes: Buffer; contentType: string } | undefined;
  /** 测试断言面（非端口方法）：已存 key 数。 */
  size(): number;
}

export function createMemoryStorage(): MemoryStorage {
  const map = new Map<string, { bytes: Buffer; contentType: string }>();
  return {
    async put(key, bytes, contentType) {
      map.set(key, { bytes: Buffer.from(bytes), contentType });
    },
    get(key) {
      const hit = map.get(key);
      return hit === undefined
        ? undefined
        : { bytes: Buffer.from(hit.bytes), contentType: hit.contentType };
    },
    size() {
      return map.size;
    },
  };
}
