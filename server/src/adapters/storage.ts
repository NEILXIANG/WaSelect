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
 * @limitation 一：⚠️ 2026-10-01 订正（B1）：旧文案写"r2 驱动未实现、枚举里刻意没有它"
 *              ——R2 适配器已落地（`storage-r2.ts`），`STORAGE_DRIVER` 现在认 `r2`。
 *              保留这条订正而不是删掉：它是"为什么曾经没有"的唯一记录，
 *              删了之后没人知道那个枚举是**有意**留空的，下次可能又被当成漏配。
 * @limitation 二：fs 落盘根目录缺省 `./var/uploads`（进程 cwd 相对）——只用于本地开发；
 *              该目录已在 .gitignore 范围内的假设**不成立**时不要提交它（见 .gitignore 检查）。
 *
 * @see config.ts（STORAGE_DRIVER / STORAGE_FS_DIR 与跨字段规则 1d）；
 *      ports/storage.ts（端口语义）；storage-r2.ts（生产驱动）
 */
import type { AppConfig } from '../config.js';
import type { Clock } from '../ports/clock.js';
import type { HttpClient } from '../ports/http-client.js';
import type { ObjectStorage } from '../ports/storage.js';
import { createMemoryStorage } from './storage-memory.js';
import { createFsStorage } from './storage-fs.js';
import { createR2Storage } from './storage-r2.js';

const DEFAULT_FS_DIR = './var/uploads';

/** r2 驱动需要的外部依赖（只有它有：要出网、要签名时间戳）。 */
export interface StorageAssemblyDeps {
  http: HttpClient;
  clock: Clock;
}

/**
 * 取必填值；缺失 → 抛。
 *
 * @why 完整性主要由 config 的跨字段规则在**启动期**拦（配了驱动却缺凭据 = 每次上传 500）；
 *      这里是第二道：**不静默补默认值**。写 `String(x)` 会把 `undefined` 变成字符串
 *      `"undefined"`，于是请求打到一个长得合法的端点上，而报错是 403/404
 *      ——排障方向被带到"凭据错了"，实际是"根本没配"。
 */
function needed(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`r2_storage_config_missing:${name}`);
  }
  return value;
}

/**
 * 解析存储驱动。返回 null 的含义见文件头 @why（生产未配置）。
 * test 缺省 memory（不碰盘不碰网）；development 缺省 fs（开发期要能预览）；
 * 显式配置优先于环境缺省。
 *
 * @param deps r2 驱动要用（fs / memory 不用）；传它是为了"出网与时钟由装配期决定"——
 *             适配器自己 `fetch` 等于绕过超时与重试（见 storage-r2.ts 文件头 @why）。
 */
export function resolveStorage(config: AppConfig, deps: StorageAssemblyDeps): ObjectStorage | null {
  if (config.STORAGE_DRIVER === 'memory') return createMemoryStorage();
  if (config.STORAGE_DRIVER === 'fs')
    return createFsStorage(config.STORAGE_FS_DIR ?? DEFAULT_FS_DIR);
  if (config.STORAGE_DRIVER === 'r2') {
    return createR2Storage({
      http: deps.http,
      clock: deps.clock,
      accountId: needed(config.R2_ACCOUNT_ID, 'R2_ACCOUNT_ID'),
      accessKeyId: needed(config.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID'),
      secretAccessKey: needed(config.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY'),
      bucket: needed(config.R2_BUCKET, 'R2_BUCKET'),
    });
  }
  if (config.NODE_ENV === 'test') return createMemoryStorage();
  if (config.NODE_ENV === 'development') {
    return createFsStorage(config.STORAGE_FS_DIR ?? DEFAULT_FS_DIR);
  }
  // staging / production 未配置：null = 上传 50000（@why 见文件头）。
  return null;
}
