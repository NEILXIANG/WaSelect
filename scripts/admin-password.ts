/**
 * 职责：重设管理员口令的 CLI 入口（B17 / AJ-209）。只做"读环境 → 解析参数 → 调用 → 打印"。
 *      全部逻辑在 `admin-password-lib.ts`（与 seed.ts / seed-lib.ts 同构）。
 *
 * 用法（在本机、能连到目标库的机器上）：
 *   npm run admin:password -- boss@example.com          # 交互输入，不回显
 *   printf '%s' "$NEW_PW" | npm run admin:password -- boss@example.com   # 管道输入
 *   DATABASE_URL=postgresql://… npm run admin:password -- boss@example.com
 *
 * ⚠️ **口令不要写在命令行上**：@measured（npm 11.7.0）`npm run … -- <邮箱> <口令>`
 *    会把参数**原样打进 stdout**（`> node -e 0 boss@example.com S3cret-…`），
 *    新口令于是明文进了终端回滚缓冲、录屏、tmux 日志与 CI 日志。
 *    所以命令行只收邮箱，口令一律从 stdin 读（DB2-05 / AJ-321）。
 * @see scripts/admin-password-lib.ts（实现与理由）
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADMIN_PASSWORD_MIN_LENGTH } from '@waselect/shared';
import { closeDb, createDb } from '../server/src/adapters/db.js';
import {
  auditAdminPasswordReset,
  describeDatabaseTarget,
  parseAdminEmailArg,
  readNewPassword,
  setAdminPassword,
  type PasswordStdin,
} from './admin-password-lib.js';

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const email = parseAdminEmailArg(process.argv.slice(2));
  if (email === undefined) {
    process.stderr.write(
      '用法：npm run admin:password -- <管理员邮箱>   （新口令从 stdin 读，交互时不回显）\n',
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

  /**
   * ⚠️ 目标库**先打印，成功失败都要看得见**（DB2-05）。
   * @why 口令泄露后的典型动作是"赶紧去生产轮换"，而 `.env` 里的 `DATABASE_URL`
   *      很可能指向本机 dev 库（本文件 `:19` 会自己加载它）。漏传生产 URL 时
   *      改的是 dev 库里同邮箱的管理员，**输出与改生产一模一样**——
   *      他以为轮换了，实际没有。只显示主机 + 库名，凭据不出现。
   */
  process.stdout.write(`[admin:password] 目标库：${describeDatabaseTarget(url)}\n`);

  const password = await readNewPassword(process.stdin as unknown as PasswordStdin, (s) => {
    process.stdout.write(s);
  });
  if (password === '') {
    process.stderr.write('[admin:password] 新口令为空，未改动\n');
    process.exitCode = 2;
    return;
  }

  const db = createDb({ url, max: 1 });
  try {
    const r = await setAdminPassword(db, { email, password });
    if (!r.ok) {
      // reason 只有两种，都是"操作者能立刻修正"的，不需要堆栈
      const text =
        r.reason === 'weak_password'
          ? `新口令太短（至少 ${String(ADMIN_PASSWORD_MIN_LENGTH)} 位，与启动校验同一口径）`
          : // ⚠️ **不打邮箱**（约束七：完整邮箱不进任何输出/日志）——
            //   旧实现在这里把邮箱原样打印，与下面成功分支的"不打印邮箱"自相矛盾
            '没有这个管理员（邮箱大小写不敏感，且必须 is_admin=true）';
      process.stderr.write(`[admin:password] 未改动：${text}\n`);
      process.exitCode = 1;
      return;
    }
    // ⚠️ 成功也**不打印邮箱**（约束七：完整邮箱不进任何输出/日志）
    process.stdout.write(
      `[admin:password] 已重设口令，token_ver=${r.tokenVer}（旧 token 已失效）\n`,
    );

    // 审计：此前这条路径在系统里不留痕（审计中间件只覆盖 HTTP 的 /admin 前缀）
    try {
      await auditAdminPasswordReset(db, r.userId);
    } catch (e) {
      // ⚠️ 审计失败**不得**回滚、也不得让退出码变成失败：口令已经改完了，
      //    把"改成功"报成"失败"会让人再跑一次（第二次会撞完全不同的状态）。
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[admin:password] ⚠️ 审计写入失败（口令**已**改动，请另记一笔）：${message.replace(/[\r\n]+/g, ' ')}\n`,
      );
    }
  } finally {
    await closeDb(db);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[admin:password] 失败：${message.replace(/[\r\n]+/g, ' ')}\n`);
  process.exitCode = 1;
});
