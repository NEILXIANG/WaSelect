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
 * @why 顺带 `token_ver + 1`（D25）：改密之后旧 token 在下一次校验时即被拒，
 *      "改了口令但攻击者手里的 token 还能用 12 小时"等于没改。
 *      ⚠️ 但**不是"立刻"**（SEC2-05 ③ / AJ-343）：服务进程里的身份缓存
 *      （`adapters/identity.ts` 的 `IDENTITY_CACHE_TTL_MS` = 60 秒）在这段时间内
 *      仍会拿缓存里的旧 `token_ver` 放行旧 token，而本 CLI 是**另一个进程**，
 *      调不到服务端的 `invalidate`（它没有跨进程通道，MVP 也没有共享缓存）。
 *      所以"改完即失效"只在**本进程签发的下一次登录**与 60 秒之后成立；
 *      输出里必须写成"最迟 60 秒"，写成"已失效"会让应急轮换的人以为攻击者已经出局。
 *
 * @limitation 只按 **is_admin = true** 定位：不提供"给任意用户改密"的能力——
 *              那是客服越权的入口，MVP 的买家侧是微信登录（没有口令）。
 * @limitation 邮箱比对大小写不敏感，且与登录侧**同一份归一**：SQL 写作
 *              "lower(email) = JS 归一后的入参"（SEC2-07；normalizeAdminEmail）。
 *              曾经写成"lower(email) = lower(入参)"，那是让 PG 再归一一次——
 *              PG 的 `lower()` 与 JS 的 `toLowerCase()` 不是同一个函数，两份归一会让
 *              "找得到这个人"与"登录记到哪个桶 / 改密清哪个桶"分叉。
 *
 * @see packages/shared/src/limits.ts（ADMIN_PASSWORD_MIN_LENGTH，与 config.ts 同源）；
 *      server/src/app/auth.ts（hashPassword）；server/src/adapters/admin-auth.ts（ensureInitialAdmin）
 */
import { ADMIN_PASSWORD_MIN_LENGTH } from '@waselect/shared';
import type { Db } from '../server/src/adapters/db.js';
import {
  deleteLoginAttemptsForEmail,
  normalizeAdminEmail,
} from '../server/src/adapters/admin-auth.js';
import { createAdminAuditStore } from '../server/src/adapters/admin-audit.js';
import { IDENTITY_CACHE_TTL_MS } from '../server/src/adapters/identity.js';
import { hashPassword } from '../server/src/app/auth.js';

/**
 * 读口令所需的 stdin 最小面（为了可测：测试喂一个假的异步可迭代对象即可）。
 *
 * @why 只声明用到的四个成员而不是直接用 `NodeJS.ReadStream`：后者带几十个成员、
 *      还依赖 `@types/node` 的实现细节，测试就得造一个真的流（要真的关掉它）。
 */
export interface PasswordStdin {
  /** 是终端 → 走原始模式逐字符读（不回显）；否则整段读（管道）。 */
  isTTY: boolean;
  /** 终端专用；管道分支可以不给。 */
  setRawMode?(v: boolean): void;
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer>;
}

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
 * 命令行参数 → 管理员邮箱。**口令不再走命令行**（DB2-05 / AJ-321）。
 *
 * @returns `undefined` = 没给邮箱或给了空串（调用方应打印用法并退出非 0）。
 * @why 口令从入参里彻底拿掉：`npm run … -- <邮箱> <口令>` 会被 npm **原样回显到 stdout**
 *      （@measured，npm 11.7.0），新口令明文进终端回滚缓冲 / 录屏 / tmux 与 CI 日志。
 *      这里只解析邮箱，口令一律由 {@link readNewPassword} 从 stdin 读（交互时不回显）。
 * @limitation 邮箱本身仍会进 shell history 与 `ps`——它是"改谁的口令"，敏感度远低于口令，
 *      且没有它就没法定位账号；约束七禁的是"完整邮箱进**日志/输出**"，history 不在此列。
 */
export function parseAdminEmailArg(argv: readonly string[]): string | undefined {
  const [email] = argv;
  if (email === undefined) return undefined;
  const trimmed = email.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 把连接串里**可以显示**的部分挑出来：主机（含端口）与库名，**凭据一律不出现**。
 *
 * @why DB2-05：改密脚本先前成功时只打印 `token_ver=N`，**不说改的是哪个库**。
 *      而口令泄露后的典型操作是"赶紧去生产轮换"，操作者漏传 `DATABASE_URL` 时
 *      改的是本机 dev 库里同邮箱的管理员——终端输出与改生产时**一模一样**，
 *      他以为轮换了，实际没有。显示主机 + 库名让"改错库"这件事当场可见。
 * @why 用 `URL` 解析而不是自己截字符串：`user:pass@` 里的 `@`、IPv6 的 `[]`、
 *      query 里的 `?host=/var/run`（unix socket）都会让手写正则切错，
 *      而切错的方向恰好是"把凭据当成主机名打印出来"。
 *
 * @param url 任意形状的 Postgres 连接串
 * @returns `host[:port]/dbname`；解析不了时给一个不含凭据的占位串
 *
 * @limitation 主机为空（unix socket 写法 `postgresql:///db?host=/var/run`，或没写协议）
 *              一律落到占位串，连库名也不打印（AJ-322）。@why 少了协议时 `new URL` 会把
 *              `user:pass@host/db` 整段当成**不透明路径**，`u.host` 是空串而
 *              `u.pathname` 是 `pass@host/db`——此时若照常拼库名，打出来的正是口令
 *              （@measured，node 22）。宁可少显示一个库名，也不能冒这个方向。
 */
export function describeDatabaseTarget(url: string): string {
  try {
    const u = new URL(url);
    // ⚠️ 主机为空就不打印任何东西：见 @limitation，那是"少写了协议"的形状，
    //    此时 pathname 里可能整段是 `口令@主机/库`。
    if (u.host === '') return '(连接串无法解析，已省略)';
    const db = u.pathname.replace(/^\//, '');
    return db.length > 0 ? `${u.host}/${db}` : u.host;
  } catch {
    // 解析失败也绝不能回退成"原样打印"——那会把凭据打进终端
    return '(连接串无法解析，已省略)';
  }
}

/**
 * 这个连接串指向的是**本机**库吗（决定要不要 `--yes` 确认，SEC2-05 ① / AJ-342）。
 *
 * @why 目标库已经打印出来了（`describeDatabaseTarget`），但打印只能防"改错库而不自知"的
 *      **一个**方向：漏传 `DATABASE_URL` 时改成本机 dev 库。反方向同样有代价——
 *      shell 里 `DATABASE_URL` 指向生产（或跳板机的 `.env` 就是生产），
 *      "我只是想本地试一下"却把生产管理员的口令换了：口令轮换是**不可逆**的
 *      （改完才知道自己改错了，而旧口令已经不在任何地方），且会立刻把所有已登录的管理员踢下线。
 *      打印解决不了这个方向——人不会细看自己每天都看到的那行字。
 * @why 判"本机"而不是判"生产名单"：本机是本脚本**最常见**的目标（dev / 本地排障），
 *      给它免确认；除此之外一律要求显式 `--yes`。保守方向落在"多打一个参数"，
 *      而不是"漏拦一次不可逆的生产写操作"。
 * @limitation 解析不出主机时按**非本机**处理（要求确认）：那时我们连"改的是哪台机器"
 *      都说不出来（`describeDatabaseTarget` 只能给占位串），唯一安全的做法就是先问一句。
 *      代价是 unix socket 写法（`postgresql:///db?host=/var/run`）也要 `--yes`——
 *      它在本地开发里并不罕见，这是刻意为"说不出口时不猜"付的小钱。
 */
export function isLocalDatabaseTarget(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.host === '') return false;
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** 命令行里有没有 `--yes`（非本机库的确认闸门，见 {@link isLocalDatabaseTarget}）。 */
export function hasYesFlag(argv: readonly string[]): boolean {
  return argv.includes('--yes');
}

/**
 * 改密成功后的那一行输出。
 *
 * @why 单独拎成函数：它含一句**必须准确**的话（旧 token 什么时候真的失效），
 *      而"准确"这件事在 CLI 薄壳里没人测得到——薄壳不在任何测试里被跑到，
 *      改错一个字不会有任何东西变红（同样的理由见 AJ-334 的源码断言）。
 * @why 60 这个数字取自 `IDENTITY_CACHE_TTL_MS` 而不是写死：写死后缓存 TTL 调成 5 秒，
 *      输出还在说"最迟 60 秒"，而**这句话是应急操作时唯一的时间预期**——
 *      它错了，要么虚惊（以为还有 60 秒窗口，其实早就断了），要么误判（以为已经安全）。
 */
export function formatResetSuccess(tokenVer: number): string {
  const seconds = Math.ceil(IDENTITY_CACHE_TTL_MS / 1000);
  return (
    `[admin:password] 已重设口令，token_ver=${String(tokenVer)}` +
    `（旧 token 最迟 ${String(seconds)} 秒内失效——服务进程的身份缓存，不是立刻）`
  );
}

/**
 * 从 stdin 读新口令：**交互时不回显**（TTY 原始模式），管道读入则整段取用。
 *
 * @why DB2-05（已探针证实，npm 11.7.0）：`npm run admin:password -- <邮箱> <口令>`
 *      会把命令行参数**原样打进 stdout**——
 *      ```
 *      > node -e 0 boss@example.com S3cret-new-password-32
 *      ```
 *      新口令于是明文进了终端回滚缓冲、录屏、tmux 日志与 CI 日志。
 *      命令行因此**只保留邮箱**，口令一律从 stdin 来。
 * @why 交互时开原始模式并**自己决定回显什么**：`readline` 没有"关闭回显"的选项，
 *      直接读就会把口令打到屏幕上；这里逐字符收集、只回显 `*`。
 * @why 管道分支不做 trim 以外的事：`echo "$PW" | npm run …` 时口令末尾的换行
 *      要去掉（否则 12 位长度校验被一个 \n 干扰得莫名其妙），但中间的空格是口令的一部分。
 *
 * @limitation 交互输入时按退格**不会**真的删字符（原始模式下要自己处理 `\u007f`），
 *              本次不做：退格在口令输入里极易按错且看不出来，宁可让人重来一次
 *              （Ctrl-C 取消）。要做就把 `\u007f` 从 buf 里 pop 掉并回退一格光标。
 */
export async function readNewPassword(
  stdin: PasswordStdin,
  out: (s: string) => void = () => undefined,
): Promise<string> {
  if (stdin.isTTY === true) {
    out('新口令（不回显，Ctrl-C 取消）：');
    stdin.setRawMode?.(true);
    let buf = '';
    try {
      for await (const chunk of stdin) {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        // 行结束符之前是本轮输入；\u0003 = Ctrl-C
        const cut = s.search(/[\r\n]/);
        const cancel = s.indexOf('\u0003');
        // ⚠️ 取消必须**先于**本轮字符判定（AJ-323）：raw mode 下 Ctrl-C 不产生 SIGINT、只是一个字节，
        //    且多个按键可能被内核合并成一个 chunk（"打了几个字符再按 Ctrl-C"）。
        //    先取 take 再判断的话，那次输入会被当成"输完了"——用户以为取消了，
        //    实际提交的是一个半截口令，而终端上只看到几个 `*`，无从发现。
        if (cancel !== -1 && (cut === -1 || cancel < cut)) throw new Error('已取消');
        const take = cut === -1 ? s : s.slice(0, cut);
        buf += take;
        out('*'.repeat([...take].length));
        if (cut !== -1) break;
      }
    } finally {
      // ⚠️ 必须还原：不还原的话终端留在原始模式，后面所有命令都不回显、Ctrl-C 也不灵
      stdin.setRawMode?.(false);
      out('\n');
    }
    return buf;
  }

  let buf = '';
  for await (const chunk of stdin) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return buf.replace(/[\r\n]+$/, '');
}

/**
 * 给"口令被重设"补一行 `admin_audit`（DB2-05）。
 *
 * @why 审计表此前只覆盖 HTTP 管理端写接口（中间件挂在 `/api/v1/admin` 前缀上），
 *      本 CLI 走的是另一条路：改完口令在系统里**不留任何痕迹**——
 *      事后回答不了"这个管理员的口令最近被改过吗 / 什么时候改的"。
 * @limitation **没有可识别的操作者**：能跑这个脚本 = 能连目标库 = 已有全部权限，
 *      进程里也没有登录态，所以 actor 只能写死成 `cli:admin-password`。
 *      它记录的是"发生过一次 CLI 改密"，**不是**"谁改的"——
 *      要后者必须在这条路径上引入身份（例如要求先登一次管理端拿短期凭证），
 *      那属于另一处设计，本轮不做，写在这里免得有人把这一行当成"已审计到人"。
 * @limitation before / after 一律 null：**口令绝不进审计表**（append-only、无保留期）。
 *
 * @throws 写入失败会抛（调用方应 catch 并告警，但**不得**因此回滚已改的口令）
 */
export async function auditAdminPasswordReset(db: Db, userId: string): Promise<void> {
  await createAdminAuditStore(db).append({
    actor: 'cli:admin-password',
    action: 'CLI admin.password.reset',
    target: userId,
    before: null,
    after: null,
    // null（不是 200）：本路径**不经过 HTTP**，没有状态码可记（迁移 025 / SEC2-02）。
    // 与历史行的 NULL 同形，语义也对得上——它只是"当时没记状态"，不是"成功了"。
    statusCode: null,
    traceId: null,
    reqId: null,
  });
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
    -- ⚠️ 右边必须是 JS 归一的结果（normalizeAdminEmail），与登录侧同一口径（SEC2-07）：
    --   PG 的 lower() 与 JS 的 toLowerCase() 不是同一个函数（'İ' 上实测不同）。
    --   本函数紧接着用 deleteLoginAttemptsForEmail（键走 JS 归一）清锁——
    --   若"找人"与"清哪个桶"用了两份归一，改密就可能清掉一个不是被锁住的那一个桶。
    update users
       set password_hash = ${hash}, token_ver = token_ver + 1
     where lower(email) = ${normalizeAdminEmail(args.email)} and is_admin = true
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
