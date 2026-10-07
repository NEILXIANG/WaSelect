/**
 * 职责：开通 / 关闭管理员 TOTP 第二因素的 CLI 入口（P1-5 / AJ-386）。逻辑在 `admin-totp-lib.ts`。
 *
 * 用法（在能连到目标库的机器上）：
 *   npm run admin:totp -- boss@example.com            # 开通（或换密钥）：打印密钥与 otpauth URI
 *   npm run admin:totp -- boss@example.com --off      # 关闭
 *   DATABASE_URL=postgresql://… npm run admin:totp -- boss@example.com --yes
 *
 * ⚠️ 远程库必须带 `--yes`（与 admin:password 同口径）：开通 / 关闭都会让该管理员所有会话立即失效。
 * ⚠️ 打印出来的密钥 = 第二因素本身：录入验证器 App 后清屏，不要贴进聊天或工单。
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
import { disableAdminTotp, enableAdminTotp } from './admin-totp-lib.js';

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const argv = process.argv.slice(2);
  const email = parseAdminEmailArg(argv);
  if (email === undefined) {
    process.stderr.write('用法：npm run admin:totp -- <管理员邮箱> [--off] [--yes]\n');
    process.exitCode = 2;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    process.stderr.write('缺少 DATABASE_URL（或 .env 里没有配置）\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`[admin:totp] 目标库：${describeDatabaseTarget(url)}\n`);
  if (!isLocalDatabaseTarget(url) && !hasYesFlag(argv)) {
    process.stderr.write(
      `[admin:totp] 目标库不是本机（${describeDatabaseTarget(url)}）：确认要改它请加 --yes\n`,
    );
    process.exitCode = 2;
    return;
  }

  const db = createDb({ url, max: 1 });
  try {
    if (argv.includes('--off')) {
      const r = await disableAdminTotp(db, email);
      if (!r.ok) {
        process.stderr.write('[admin:totp] 未改动：没有这个管理员\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write('[admin:totp] 已关闭第二因素；该管理员现有会话已全部失效\n');
      return;
    }
    const r = await enableAdminTotp(db, email);
    if (!r.ok) {
      process.stderr.write('[admin:totp] 未改动：没有这个管理员（必须 is_admin=true）\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      [
        '[admin:totp] 已开通（或已换密钥）；该管理员现有会话已全部失效。',
        '把下面任意一行录入验证器 App（Google Authenticator / 1Password 等），然后清屏：',
        `  密钥：${r.secret}`,
        `  URI ：${r.uri}`,
        '此后登录：口令 + App 上的 6 位码。',
        '',
      ].join('\n'),
    );
  } finally {
    await closeDb(db);
  }
}

void main().catch((e: unknown) => {
  process.stderr.write(`[admin:totp] 失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
