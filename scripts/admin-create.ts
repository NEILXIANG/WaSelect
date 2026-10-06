/**
 * 职责：新建管理员账号的 CLI 入口（剩余清单 3-1）。只做"读环境 → 解析参数 → 调用 → 打印"，
 *      逻辑在 `admin-password-lib.ts` 的 `createAdminAccount`（与改密脚本同一份邮箱解析、目标库描述、stdin 读口令）。
 *
 * 用法：
 *   npm run admin:create -- ops2@example.com                       # 交互输入口令，不回显
 *   DATABASE_URL=postgresql://… npm run admin:create -- ops2@example.com --yes   # 远程库须 --yes
 *
 * ⚠️ 口令不走命令行（npm 会把参数原样回显到 stdout，见 admin-password.ts 的 @measured）。
 * ⚠️ 远程库必须 `--yes`：建号是给某人一把全权钥匙，建错库要能在读口令之前就被拦下。
 * @limitation 建出来的都是全权管理员；停用 / 删除账号当前只能改库（P1：账号管理页）。
 * @see scripts/admin-password-lib.ts（createAdminAccount）；scripts/admin-password.ts（同构）
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADMIN_PASSWORD_MIN_LENGTH } from '@waselect/shared';
import { closeDb, createDb } from '../server/src/adapters/db.js';
import {
  createAdminAccount,
  describeDatabaseTarget,
  hasYesFlag,
  isLocalDatabaseTarget,
  parseAdminEmailArg,
  readNewPassword,
  type PasswordStdin,
} from './admin-password-lib.js';

const TAG = '[admin:create]';

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const argv = process.argv.slice(2);
  const email = parseAdminEmailArg(argv);
  if (email === undefined) {
    process.stderr.write(
      '用法：npm run admin:create -- <新管理员邮箱> [--yes]   （口令从 stdin 读）\n',
    );
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
    process.stderr.write(`${TAG} 目标库不是本机：确认要在它上面建管理员请加 --yes\n`);
    process.exitCode = 2;
    return;
  }
  const password = await readNewPassword(process.stdin as unknown as PasswordStdin, (s) => {
    process.stdout.write(s);
  });
  if (password === '') {
    process.stderr.write(`${TAG} 口令为空，未建号\n`);
    process.exitCode = 2;
    return;
  }
  const db = createDb({ url, max: 1 });
  try {
    const r = await createAdminAccount(db, { email, password });
    if (!r.ok) {
      // ⚠️ 不打邮箱（约束七）
      const text =
        r.reason === 'weak_password'
          ? `口令太短（至少 ${String(ADMIN_PASSWORD_MIN_LENGTH)} 位）`
          : '这个邮箱已有账号（改口令请用 npm run admin:password；不会把普通账号提成管理员）';
      process.stderr.write(`${TAG} 未建号：${text}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${TAG} 已建管理员（id=${r.userId}），审计已记录\n`);
  } finally {
    await closeDb(db);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${TAG} 失败：${message.replace(/[\r\n]+/g, ' ')}\n`);
  process.exitCode = 1;
});
