/**
 * 职责：按配置解析 ObjectStorage 驱动（I2 U-I4）——**构造**归 bootstrap，装配归 mount。
 *
 * @why 解析规则集中在这一个函数，而不是散在 main.ts / mount.ts：
 *      "什么环境用什么驱动"是配置语义的另一半（config.ts 管"值合不合法"，本函数管"值意味着什么"），
 *      两处各写一份必然漂移。
 *
 * @why 生产未配置 → `null`（不是抛错、不是降级 fs）：
 *      抛错会连"不需要上传的部署"都起不来；降级 fs = Render 易失盘，
 *      "上传成功、随后图静默消失"且没有任何一方报错。
 *      null 由上传路由 50000 响亮拒绝——与 wechat 未配置的同款处理（mount.ts 既有先例）。
 *
 * @limitation 一：r2 驱动**未实现**（凭据在公司登记链后，6–10 周）——
 *              `STORAGE_DRIVER` 枚举里刻意没有它：配上不存在的驱动比"没配"更难排查。
 * @limitation 二：fs 落盘根目录缺省 `./var/uploads`（进程 cwd 相对）——只用于本地开发；
 *              该目录已在 .gitignore 范围内的假设**不成立**时不要提交它（见 .gitignore 检查）。
 *
 * @see config.ts（STORAGE_DRIVER / STORAGE_FS_DIR 与跨字段规则 1d）；
 *      ports/storage.ts（端口语义）
 */
import type { AppConfig } from '../config.js';
import type { ObjectStorage } from '../ports/storage.js';
import { createMemoryStorage } from './storage-memory.js';
import { createFsStorage } from './storage-fs.js';

const DEFAULT_FS_DIR = './var/uploads';

/**
 * 解析存储驱动。返回 null 的含义见文件头 @why（生产未配置）。
 * test 缺省 memory（不碰盘不碰网）；development 缺省 fs（开发期要能预览）；
 * 显式配置优先于环境缺省。
 */
export function resolveStorage(config: AppConfig): ObjectStorage | null {
  if (config.STORAGE_DRIVER === 'memory') return createMemoryStorage();
  if (config.STORAGE_DRIVER === 'fs')
    return createFsStorage(config.STORAGE_FS_DIR ?? DEFAULT_FS_DIR);
  if (config.NODE_ENV === 'test') return createMemoryStorage();
  if (config.NODE_ENV === 'development') {
    return createFsStorage(config.STORAGE_FS_DIR ?? DEFAULT_FS_DIR);
  }
  // staging / production 未配置：r2 适配器未落地（@limitation 一），null = 上传 50000。
  return null;
}
