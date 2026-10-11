/**
 * 职责：撤销管理员的 CLI 入口（离职处置）。逻辑在 `admin-revoke-lib.ts`。
 *
 * 用法（在能连到目标库的机器上）：
 *   npm run admin:revoke -- leaver@example.com
 *   DATABASE_URL=postgresql://… npm run admin:revoke -- leaver@example.com --yes
 *
 * ⚠️ 远程库必须带 `--yes`（与 admin:password / admin:totp 同口径）：撤销立即让该管理员所有会话失效，且不可在界面上恢复。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDb, createDb } from '../server/src/adapters/db.js';
import {
  describeDatabaseTarget,
  hasYesFlag,
  isLocalDatabaseTarget,
  parseAdminEmailArg,
} from './admin-password-lib.js';
import { revokeAdmin } from './admin-revoke-lib.js';

const TAG = '[admin:revoke]';

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const argv = process.argv.slice(2);
  const email = parseAdminEmailArg(argv);
  if (email === undefined) {
    process.stderr.write('用法：npm run admin:revoke -- <管理员邮箱> [--yes]\n');
    process.exitCode = 2;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    process.stderr.write('缺少 DATABASE_URL（或 .env 里没有配置）\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${TAG} 目标库：${describeDatabaseTarget(url)}\n`);
  if (!isLocalDatabaseTarget(url) && !hasYesFlag(argv)) {
    process.stderr.write(
      `${TAG} 目标库不是本机（${describeDatabaseTarget(url)}）：确认要改它请加 --yes\n`,
    );
    process.exitCode = 2;
    return;
  }

  const db = createDb({ url, max: 1 });
  try {
    const r = await revokeAdmin(db, email);
    if (!r.ok) {
      process.stderr.write(
        r.reason === 'last_admin'
          ? `${TAG} 未改动：这是最后一个能登录后台的管理员，撤掉后谁都进不了后台。先用 admin:create 建好接手的人（并开通 admin:totp）再撤\n`
          : `${TAG} 未改动：没有这个管理员（必须 is_admin=true）\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `${TAG} 已撤销管理员权限；他所有已登录的后台会话立即失效，手机验证密钥已清除（服务进程缓存最长 60 秒后生效）\n`,
    );
  } finally {
    await closeDb(db);
  }
}

void main().catch((e: unknown) => {
  process.stderr.write(`${TAG} 失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
