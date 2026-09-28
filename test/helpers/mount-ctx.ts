/**
 * 职责：路由装配（`mountAllRoutes`）的 **stub 上下文**——让测试能"把路由挂出来"
 *      而不需要真数据库。
 *
 * @why 抽成 helper 而不是每个测试各写一份：`db 调用即抛` 这条自证（mount.ts @limitation 一：
 *      挂载期不触库）如果写散在 N 个测试里，将来有人想在挂载期加 IO 时只需改 N 处中的一处
 *      就能绕过——集中一份，绕无可绕。
 *
 * @limitation 只保证"挂载"阶段可用：任何 handler 真正执行到触库处都会抛
 *      （那正是它的职责）。需要 handler 真跑通全链路的测试请用真库（main.db.test / e2e）。
 *
 * @see server/src/app/mount.ts（@limitation 一）；routes.contract.test.ts / rate-limit.unit.test.ts
 */
import { loadConfig, type AppConfig } from '../../server/src/config.js';
import type { Logger } from '../../server/src/logger.js';
import type { Db } from '../../server/src/adapters/db.js';
import { createEventBus } from '../../server/src/adapters/event-bus.js';
import { createMemoryStorage } from '../../server/src/adapters/storage-memory.js';
import type { MountContext } from '../../server/src/app/mount.js';

/** 默认的合法环境（与 config.unit.test.ts 的 baseEnv 同源口径）。 */
const STUB_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://app@localhost:5432/japan_shop',
  JWT_SECRET: 'a'.repeat(32),
  PAYMENT_CHANNELS: 'mock,stripe',
  TERMS_VERSION: 'TOS-2026-09-20',
};

export interface StubMountContextOptions {
  logger: Logger;
  env?: NodeJS.ProcessEnv | undefined;
  config?: AppConfig | undefined;
}

/** 构造 stub 上下文。`db` 被调用即抛（挂载期必须无 IO 的自证）。 */
export function stubMountContext(opts: StubMountContextOptions): MountContext {
  const db = (() => {
    throw new Error('stub 上下文不允许触库：挂载期必须无 IO（mount.ts @limitation 一）');
  }) as unknown as Db;
  return {
    config: opts.config ?? loadConfig({ ...STUB_ENV, ...opts.env }),
    logger: opts.logger,
    db,
    events: createEventBus(opts.logger),
    // memory 驱动：构造期无 IO（挂载期无 IO 的自证不破）；handler 真跑到的测试请用真库 + 显式依赖袋
    storage: createMemoryStorage(),
  };
}
