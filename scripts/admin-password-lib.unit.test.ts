/**
 * 职责：`admin-password-lib.ts` 里**不碰库**的那三个函数的验证（DB2-05 / AJ-321）。
 *      真库部分（`setAdminPassword` / 审计落表）在 `admin-password-lib.db.test.ts`。
 *
 * @why 拆出本文件而不是全塞进 db 用例：这三个是纯函数（参数 → 返回值），
 *      db project 是**串行**的（`fileParallelism: false`，共库 + TRUNCATE 重置），
 *      把二十来条毫秒级的断言塞进去只会拖慢那一层；这里归 unit，秒级返回。
 *
 * @why 这三个函数值得各钉一组：它们管的是**同一件事故的同一个面**——
 *      口令在被递到数据库之前的那几厘米路。
 *      · `parseAdminEmailArg`：命令行只留邮箱（口令不再走 argv）；
 *      · `readNewPassword`：口令从 stdin 来，且**交互时不回显**；
 *      · `describeDatabaseTarget`：改的是哪个库要当场可见，而凭据永远不可见。
 *      三条里任意一条退化，症状都是"口令明文出现在终端/日志里"，
 *      而这类泄漏**没有任何一方会报错**，只有断言能发现。
 *
 * @see scripts/admin-password-lib.ts（被测）；scripts/admin-password.ts（CLI 薄壳）
 */
import { describe, expect, it } from 'vitest';
import {
  describeDatabaseTarget,
  parseAdminEmailArg,
  readNewPassword,
  type PasswordStdin,
} from './admin-password-lib.js';

/**
 * 造一个假 stdin：逐块吐出给定内容，并记录 raw mode 的开关序列。
 *
 * @why 记录 `rawModes` 而不是只断言"最后关掉了"：漏还原的后果是**终端此后不回显、
 *      Ctrl-C 也不灵**，那是留在别人机器上的坑；只测成功路径会放过"抛异常时没还原"。
 */
function fakeStdin(
  chunks: readonly (string | Buffer)[],
  opts: { tty?: boolean } = {},
): PasswordStdin & { rawModes: boolean[] } {
  const rawModes: boolean[] = [];
  return {
    isTTY: opts.tty === true,
    setRawMode(v: boolean): void {
      rawModes.push(v);
    },
    rawModes,
    async *[Symbol.asyncIterator](): AsyncGenerator<string | Buffer> {
      for (const c of chunks) yield c;
    },
  };
}

describe('parseAdminEmailArg（命令行只收邮箱）', () => {
  it('一个位置参数就够（口令不再从 argv 来）', () => {
    expect(parseAdminEmailArg(['boss@example.com'])).toBe('boss@example.com');
  });

  /**
   * @why 这条是 DB2-05 的正面钉：`npm run … -- <邮箱> <口令>` 会把 argv **原样回显到 stdout**
   *      （@measured，npm 11.7.0）。旧实现在这里把第二个参数当口令收下并往下传，
   *      于是"改一次口令"就等于"把新口令明文写进终端回滚缓冲 / 录屏 / CI 日志"。
   *      现在第二个参数只是**被忽略的多余参数**，不是口令。
   */
  it('🔴 多余参数一律忽略：第二个位置参数不再是口令', () => {
    expect(parseAdminEmailArg(['a@b.c', 'pw-1234567890', '--force'])).toBe('a@b.c');
  });

  it('缺参 / 空串 / 全空白 → undefined（调用方应打印用法并退出非 0）', () => {
    expect(parseAdminEmailArg([])).toBeUndefined();
    expect(parseAdminEmailArg([''])).toBeUndefined();
    expect(parseAdminEmailArg(['   '])).toBeUndefined();
  });

  it('前后空白被 trim：手抄邮箱带空格不该表现为"找不到这个管理员"', () => {
    expect(parseAdminEmailArg(['  a@b.c  '])).toBe('a@b.c');
  });
});

describe('describeDatabaseTarget（只显示主机与库名）', () => {
  it('标准连接串 → host[:port]/dbname，凭据不出现', () => {
    expect(describeDatabaseTarget('postgresql://admin:S3cret@db.example.com:5432/japan_shop')).toBe(
      'db.example.com:5432/japan_shop',
    );
  });

  it('带 query 的连接串：库名仍取路径段', () => {
    expect(
      describeDatabaseTarget('postgresql://admin:S3cret@db.example.com/japan_shop?sslmode=require'),
    ).toBe('db.example.com/japan_shop');
  });

  it('IPv6 主机：方括号保留（否则看不出这是个 IPv6 地址）', () => {
    expect(describeDatabaseTarget('postgresql://admin:S3cret@[::1]:5432/jp')).toBe('[::1]:5432/jp');
  });

  /**
   * @why 这是本函数**唯一会出事**的方向，而且出事即泄漏：
   *      @measured（node 22）`new URL('user:secret-pass@dbhost/shop')` 不抛错，
   *      它把 `user:` 当成 scheme、`secret-pass@dbhost/shop` 当成**不透明路径**，
   *      于是 `u.host` 是空串而 `u.pathname` 里整段是 `口令@主机/库`——
   *      照常拼 `host/dbname` 打出来的正是口令。
   *      同理 `postgresql:///db?host=/var/run`（unix socket）也是空主机。
   *      宁可少显示一个库名，也不能冒这个方向。
   */
  it('🔴 主机为空（少协议 / unix socket）→ 占位串，绝不把 user:pass@… 当库名打出来', () => {
    const s = describeDatabaseTarget('user:secret-pass@dbhost/shop');
    expect(s).not.toContain('secret-pass');
    expect(s).toBe('(连接串无法解析，已省略)');

    expect(describeDatabaseTarget('postgresql:///japan_shop?host=/var/run/postgresql')).toBe(
      '(连接串无法解析，已省略)',
    );
  });

  it('🔴 完全解析不了 → 占位串（绝不回退成"原样打印"）', () => {
    const s = describeDatabaseTarget('not a url at all');
    expect(s).toBe('(连接串无法解析，已省略)');
    expect(s).not.toContain('not a url');
  });
});

describe('readNewPassword（口令从 stdin 来）', () => {
  it('管道：整段读入，只去**末尾**换行', async () => {
    await expect(readNewPassword(fakeStdin(['pw-1234567890\n']))).resolves.toBe('pw-1234567890');
  });

  /**
   * @why 中间的空格是口令的一部分（有人用短语当口令），末尾的换行是 `echo` 加的。
   *      一律 trim 会让"以空格结尾的口令"被悄悄改短，而校验通过、登录失败，
   *      排查方向会指向"口令记错了"而不是"脚本删了最后一个字符"。
   */
  it('🔴 管道：中间空格保留、只去尾部换行（含 CRLF 与多个换行）', async () => {
    await expect(readNewPassword(fakeStdin(['pass word-12', '\n']))).resolves.toBe('pass word-12');
    await expect(readNewPassword(fakeStdin(['pw-1234567890\r\n']))).resolves.toBe('pw-1234567890');
    await expect(readNewPassword(fakeStdin(['pw-1234567890\n\n']))).resolves.toBe('pw-1234567890');
    // ⚠️ 末尾空格是口令的一部分：整体 `trim()` 会把它吃掉——校验照样通过、登录却失败，
    //    排查方向会指向"口令记错了"而不是"脚本删了最后一个字符"。
    await expect(readNewPassword(fakeStdin(['pw-1234567890  \n']))).resolves.toBe(
      'pw-1234567890  ',
    );
  });

  it('管道：Buffer 块也能读（`process.stdin` 默认就是 Buffer）', async () => {
    await expect(
      readNewPassword(fakeStdin([Buffer.from('pw-1234567890\n', 'utf8')])),
    ).resolves.toBe('pw-1234567890');
  });

  /**
   * @why 回显是本函数的全部意义：交互模式下若把字符原样打出来，
   *      新口令就明文留在屏幕上（且终端回滚缓冲里也能翻到）。
   *      断言"输出里不含口令"还不够——那会被"什么都不输出"满足，
   *      所以同时断言**等长的 `*`** 与提示语，确保人看得到自己在输入。
   */
  it('🔴 TTY：一个明文字符都不回显，只回显等长的 *（并给出提示语）', async () => {
    const out: string[] = [];
    const stdin = fakeStdin(['p', 'w', '-', '1', '2', '\r'], { tty: true });
    const pw = await readNewPassword(stdin, (s) => {
      out.push(s);
    });
    expect(pw).toBe('pw-12');
    expect(out.join('')).toBe('新口令（不回显，Ctrl-C 取消）：*****\n');
    expect(out.join('')).not.toContain('pw-12');
  });

  /**
   * @why 漏还原的后果留在**别人的终端**上：此后所有命令都不回显、Ctrl-C 也不灵，
   *      且不做 `reset` 就好不了。取消路径尤其容易漏——它走的是 throw。
   */
  it('🔴 TTY：正常结束与被取消，raw mode 都被还原', async () => {
    const ok = fakeStdin(['a', '\r'], { tty: true });
    await readNewPassword(ok);
    expect(ok.rawModes).toEqual([true, false]);

    const cancelled = fakeStdin(['a', '\u0003'], { tty: true });
    await expect(readNewPassword(cancelled)).rejects.toThrow('已取消');
    expect(cancelled.rawModes).toEqual([true, false]);
  });

  /**
   * @why raw mode 下 Ctrl-C **不产生 SIGINT**，它只是一个字节 0x03 混在输入里；
   *      而多个按键可能被内核合并进同一个 chunk（"打了几个字符再按 Ctrl-C"）。
   *      先取"本轮字符"再判断取消的话，那次输入会被当成"输完了"——
   *      用户以为取消了，实际提交的是一个**半截口令**，而屏幕上只有几个 `*`，无从发现。
   */
  it('🔴 打了几个字符再按 Ctrl-C → 取消，而不是提交一个半截口令', async () => {
    await expect(readNewPassword(fakeStdin(['ab\u0003'], { tty: true }))).rejects.toThrow('已取消');
    await expect(readNewPassword(fakeStdin(['ab', 'c\u0003'], { tty: true }))).rejects.toThrow(
      '已取消',
    );
  });

  it('TTY：chunks 跨块拼接（一个块只给半个字符序列）也能完整收齐', async () => {
    await expect(
      readNewPassword(fakeStdin(['pw-12', '345678', '90\n'], { tty: true })),
    ).resolves.toBe('pw-1234567890');
  });
});
