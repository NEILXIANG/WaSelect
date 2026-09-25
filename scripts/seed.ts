/**
 * 职责：一键灌数据的 CLI 入口（F9-f）。只做"读环境 → 校验目标 → 调用核心逻辑 → 打印"。
 *      所有可被测试的逻辑都在 seed-lib.ts；本文件刻意薄到"没有值得测的东西"。
 *
 * 用法：
 *   npm run db:seed           # 灌精简 demo 店（4 商品）
 *   npm run db:seed -- --full # 灌完整商品目录
 *
 * @see scripts/seed-lib.ts（安全闸门与幂等的全部实现与理由）
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDb, closeDb } from '../server/src/adapters/db.js';
import { assertSafeTarget, defaultDevUrl, seedOnce } from './seed-lib.js';

async function main(): Promise<void> {
  const full = process.argv.includes('--full');
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  // 未配置时回落到本机 dev 库（defaultDevUrl）——"一键"的底线是零配置
  const url = process.env.DATABASE_URL ?? defaultDevUrl();
  assertSafeTarget(url);

  const db = createDb({ url, max: 2 });
  try {
    const { clearedTables, bundle, counts } = await seedOnce(db, { full });
    process.stdout.write(
      `[db:seed] 已重置 ${clearedTables} 张业务表（保留配置表），灌入「${bundle.name}」：\n` +
        `  ${bundle.description}\n` +
        `  users=${counts.users} addresses=${counts.addresses} ` +
        `products=${counts.products} shipping_rates=${counts.shippingRates}\n`,
    );
  } finally {
    await closeDb(db);
  }
}

main().catch((err: unknown) => {
  // 失败要 exit 非 0 且信息单行——它会被 npm script 与终端直接读
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[db:seed] 失败：${message.replace(/[\r\n]+/g, ' ')}\n`);
  process.exitCode = 1;
});
