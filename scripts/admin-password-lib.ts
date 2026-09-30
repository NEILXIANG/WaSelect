/**
 * 职责：重设**管理员**口令的全部逻辑（B17 / AJ-209）。CLI 薄壳在 `admin-password.ts`，
 *      这里刻意可被测试直接调用（与 seed-lib / seed 同构）。
 *
 * @why 必须有这条路径：`ADMIN_INITIAL_PASSWORD` 是"seed 时建号"用的（只建不改），
 *      初始口令因此**永远留在平台的环境变量里且无法轮换**——AJ-181 写"建号后可删本变量"，
 *      但 B17 之前删了会让服务拒绝启动（config 规则 1e 要求成对），不删则无从轮换：
 *      两条路都不通。本脚本是"口令泄露/定期轮换"时的出口。
 *
 * @why 做成**本机 CLI** 而不是 `POST /admin/me/password`：
 *      ① 改密接口需要契约、前端表单、审计与"旧口令校验"一整套，而它的使用频率是**每年几次**——
 *         为一个低频动作新增一个长期在线的写接口，攻击面与维护成本都远大于收益（保守方向）；
 *      ② 谁能跑这个脚本 = 谁能连生产库 = 已经有全部权限，不新增权限边界。
 *
 * @why 顺带 `token_ver + 1`（D25）：改密之后旧 token 必须立刻失效，
 *      "改了口令但攻击者手里的 token 还能用 12 小时"等于没改。
 *
 * @limitation 只按 **is_admin = true** 定位：不提供"给任意用户改密"的能力——
 *              那是客服越权的入口，MVP 的买家侧是微信登录（没有口令）。
 * @limitation 邮箱比对大小写不敏感（`lower(email)`），与 `ensureInitialAdmin` 同一口径
 *              （seed 的"已有同邮箱账号一律不动"也用 lower）。
 *
 * @see packages/shared/src/limits.ts（ADMIN_PASSWORD_MIN_LENGTH，与 config.ts 同源）；
 *      server/src/app/auth.ts（hashPassword）；server/src/adapters/admin-auth.ts（ensureInitialAdmin）
 */
import { ADMIN_PASSWORD_MIN_LENGTH } from '@waselect/shared';
import type { Db } from '../server/src/adapters/db.js';
import { deleteLoginAttemptsForEmail } from '../server/src/adapters/admin-auth.js';
import { hashPassword } from '../server/src/app/auth.js';

export interface SetAdminPasswordArgs {
  /** 管理员邮箱（大小写不敏感）。 */
  email: string;
  /** 新口令（明文；只在本进程内存里存在，不落盘、不进日志）。 */
  password: string;
}

export type SetAdminPasswordResult =
  | { ok: true; userId: string; tokenVer: number }
  | { ok: false; reason: 'weak_password' | 'admin_not_found' };

/**
 * 命令行参数 → 入参。
 * @returns `undefined` = 参数不对（用法错误，调用方应打印用法并退出非 0）。
 * @limitation 口令走命令行参数：它**会**留在 shell history 里，也会出现在 `ps` 输出中
 *      （此处曾写"参数至少不会落进 history 文件"——不成立，与 `admin-password.ts` 文件头的说法也相反，AJ-241 更正）。
 *      环境变量传口令同样会进 history（`export` 那一行），两者都不干净。
 *      真正干净的形态是交互式输入（不回显），已登记为待办；在那之前，跑完请清掉这条 history。
 */
export function parseAdminPasswordArgs(argv: readonly string[]): SetAdminPasswordArgs | undefined {
  const [email, password] = argv;
  if (email === undefined || password === undefined) return undefined;
  const trimmed = email.trim();
  if (trimmed === '' || password === '') return undefined;
  return { email: trimmed, password };
}

export async function setAdminPassword(
  db: Db,
  args: SetAdminPasswordArgs,
): Promise<SetAdminPasswordResult> {
  // 与 config.ts 的启动校验**同一常量**（shared/limits.ts）：
  // 两边各写一个 12 的话，"脚本设了 8 位 → 下次部署拒绝启动"要等到下次部署才发现。
  if (args.password.length < ADMIN_PASSWORD_MIN_LENGTH)
    return { ok: false, reason: 'weak_password' };
  const hash = await hashPassword(args.password);
  const rows = await db`
    update users
       set password_hash = ${hash}, token_ver = token_ver + 1
     where lower(email) = lower(${args.email}) and is_admin = true
     returning id, token_ver
  `;
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'admin_not_found' };
  /**
   * 改密成功后**解除该邮箱的登录锁定**（AJ-241）。
   * @why 登录额度按邮箱计（`login_attempts`，键 = sha256(lower(email))），连错 5 次锁 15 分钟；
   *      IP 限流也是 5 次 / 15 分钟——知道邮箱的人用一个 IP 就能让它一直锁着。
   *      管理员被这样锁在门外时，唯一的自救手段就是本脚本；不清额度行的话，
   *      改完的新口令照样 42901，而全库没有第二条解锁路径。
   * @why 只在改密**成功**之后清：没改成却解了锁，等于给"知道邮箱的人"一个免费的重置计数器。
   * @limitation 与上面的 update 不在同一个事务里：清额度行失败时口令已改、锁还在，再跑一次本脚本即可
   *              （两步都是幂等的）。为此引入事务包装不值得。
   */
  // AJ-243：邮箱桶 + 记在它名下的全部来源桶一起清（来源桶的键里混了来源，单凭邮箱算不出来）
  await deleteLoginAttemptsForEmail(db, args.email);
  return { ok: true, userId: String(row['id']), tokenVer: Number(row['token_ver']) };
}
