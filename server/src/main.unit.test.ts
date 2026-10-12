/**
 * 职责：组装根的 L0 单测——只覆盖**不需要数据库**的纯函数（A1）。
 * 需要真库的部分在 main.db.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './config.js';
import { formatStartupError, isSelfEntry } from './main.js';

/**
 * N10：启动失败的 stderr 输出必须**逐行列出全部配置问题**。
 *
 * @why 过去 catch 只打 `e.message`（"配置校验失败，服务拒绝启动"）——issues 全被吞掉，
 *      运维只能改一个变量、重启、再改一个，逐次试错；而配置层的设计初衷恰恰是
 *      "一次列全，不逐个试错重启"（config.ts:356）。formatStartupError 抽成纯函数，
 *      让这条行为可以不启进程直接断言。
 */
describe('formatStartupError（N10）', () => {
  it('ConfigError：首行是总述，随后逐行列出每个 issue（缩进可辨）', () => {
    const e = new ConfigError('配置校验失败，服务拒绝启动', [
      'JWT_SECRET: Too small: expected string to have >=32 characters',
      'PAYMENT_CHANNELS: 必填',
    ]);
    const lines = formatStartupError(e);
    expect(lines[0]).toContain('配置校验失败');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('JWT_SECRET');
    expect(lines[2]).toContain('PAYMENT_CHANNELS');
    // 每个 issue 一行：这是"一次列全"的载体，合并成一行等于回到逐个试错
    expect(lines[1]).not.toContain('PAYMENT_CHANNELS');
  });

  it('普通 Error：单行（message），不编造不存在的 issues', () => {
    const lines = formatStartupError(new Error(' Postgres 版本不足 '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Postgres 版本不足');
  });

  it('非 Error 抛出值：String() 兜底，不崩', () => {
    const lines = formatStartupError('weird throw');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('weird throw');
  });
});

/**
 * N21：入口判断要"比真实路径"，不是"比文件名后缀"。
 *
 * @why 旧实现 `entry.endsWith('/main.js')` 是**假阳性制造机**：任何叫 main.js 的文件
 *      （脚本、工具、别的包）被 node 直接执行时，只要它间接 import 了本模块，
 *      就会误触 `bootstrap()` 自启服务——一个工具脚本突然开始监听端口。
 *      另一头 `new URL().pathname` 不解码转义、Windows 下直接错（C:\...）。
 *      正解：`fileURLToPath` + `realpathSync` 双边比真实路径（npm link/软链场景也能认）。
 */
describe('isSelfEntry（N21）', () => {
  const self = join(mkdtempSync(join(tmpdir(), 'entry-')), 'main.js');
  writeFileSync(self, '// placeholder');

  it('argv[1] 就是自身 → true', () => {
    expect(isSelfEntry(self, self)).toBe(true);
  });

  it('argv[1] 是指向自身的软链 → true（npm link / bin 软链场景）', () => {
    // 链接放进每次新建的临时目录（2026-10-12：原放在系统临时目录根、按 pid 命名且不清理——
    // 攒了 686 个，pid 一复用 symlinkSync 就 EEXIST，正是 gate:fast 偶发那一条红）
    const link = join(mkdtempSync(join(tmpdir(), 'entry-link-')), 'main.js');
    symlinkSync(self, link);
    expect(isSelfEntry(self, link)).toBe(true);
  });

  it('argv[1] 是**另一个**同名 main.js → false（旧 endsWith 实现的假阳性回归）', () => {
    const other = join(mkdtempSync(join(tmpdir(), 'other-')), 'main.js');
    writeFileSync(other, '// different file, same name');
    expect(isSelfEntry(self, other)).toBe(false);
  });

  it('argv[1] 为 undefined（REPL / 被 import）→ false', () => {
    expect(isSelfEntry(self, undefined)).toBe(false);
  });

  it('argv[1] 指向不存在的路径 → false，不抛（realpathSync 失败必须被吞）', () => {
    expect(isSelfEntry(self, '/nonexistent/path/main.js')).toBe(false);
  });
});
