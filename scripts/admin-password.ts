/**
 * 职责：重设管理员口令的 CLI 入口（B17 / AJ-209）。只做"读环境 → 解析参数 → 调用 → 打印"。
 *      全部逻辑在 `admin-password-lib.ts`（与 seed.ts / seed-lib.ts 同构）。
 *
 * 用法（在本机、能连到目标库的机器上）：
 *   npm run admin:password -- boss@example.com 'new-password-32'
 *   DATABASE_URL=postgresql://… npm run admin:password -- boss@example.com 'new-password-32'
 *
 * ⚠️ 口令会出现在 shell history 与 `ps` 输出里；跑完请清 history。
 * @see scripts/admin-password-lib.ts（实现与理由）
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDb, createDb } from '../server/src/adapters/db.js';
import { parseAdminPasswordArgs, setAdminPassword } from './admin-password-lib.js';

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const args = parseAdminPasswordArgs(process.argv.slice(2));
  if (args === undefined) {
    process.stderr.write('用法：npm run admin:password -- <管理员邮箱> <新口令（≥12 位）>\n');
    process.exitCode = 2;
    return;
  }

  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    process.stderr.write('缺少 DATABASE_URL（或 .env 里没有配置）\n');
    process.exitCode = 2;
    return;
  }

  const db = createDb({ url, max: 1 });
  try {
    const r = await setAdminPassword(db, args);
    if (!r.ok) {
      // reason 只有两种，都是"操作者能立刻修正"的，不需要堆栈
      const text =
        r.reason === 'weak_password'
          ? `新口令太短（至少 12 位，与启动校验同一口径）`
          : `没有这个管理员（邮箱大小写不敏感，且必须 is_admin=true）：${args.email}`;
      process.stderr.write(`[admin:password] 未改动：${text}\n`);
      process.exitCode = 1;
      return;
    }
    // ⚠️ 成功也**不打印邮箱**（约束七：完整邮箱不进任何输出/日志）
    process.stdout.write(
      `[admin:password] 已重设口令，token_ver=${r.tokenVer}（旧 token 已失效）\n`,
    );
  } finally {
    await closeDb(db);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[admin:password] 失败：${message.replace(/[\r\n]+/g, ' ')}\n`);
  process.exitCode = 1;
});
