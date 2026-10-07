/**
 * 职责：`npm run dev:images`——给本地库里没有图的商品生成开发用商品图（逻辑在 dev-images-lib.ts）。
 * ⚠️ 只写本地盘（STORAGE_FS_DIR，缺省 ./var/uploads）；目标库不是本机时拒绝。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDb, createDb } from '../server/src/adapters/db.js';
import { createFsStorage } from '../server/src/adapters/storage-fs.js';
import { describeDatabaseTarget, isLocalDatabaseTarget } from './admin-password-lib.js';
import { attachDevImages } from './dev-images-lib.js';

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL ?? '';
  if (url === '' || !isLocalDatabaseTarget(url)) {
    process.stderr.write(
      `[dev:images] 只给本机库生成（当前：${url === '' ? '未配置' : describeDatabaseTarget(url)}）\n`,
    );
    process.exitCode = 2;
    return;
  }
  const db = createDb({ url, max: 1 });
  try {
    const n = await attachDevImages(
      db,
      createFsStorage(process.env.STORAGE_FS_DIR ?? './var/uploads'),
    );
    process.stdout.write(
      `[dev:images] ${describeDatabaseTarget(url)}：已为 ${String(n)} 件商品生成图片\n`,
    );
  } finally {
    await closeDb(db);
  }
}

void main().catch((e: unknown) => {
  process.stderr.write(`[dev:images] 失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
