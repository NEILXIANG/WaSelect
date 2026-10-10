/**
 * 门禁运行器（统一结论操作律 1 / AJ-423）：日志最后一行由运行器自己写 `gate-exit=<被测命令的真实退出码>`，
 * 且运行器以同一个退出码结束。
 *
 * @why §2 第 43 / 106 条：两次把"管道末尾命令的退出码"当成门禁结果。运行器不经管道取退出码，
 *      交付与报告只认它写下的最后一行。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLogged } from './run-gate.mjs';

const node = process.execPath;
/** 单测里不回显子进程输出：它们故意打印的"gate-exit=7"会混进外层门禁的屏幕输出与日志。 */
const quiet = { echo: false } as const;
const logIn = (): string => join(mkdtempSync(join(tmpdir(), 'run-gate-')), 'nested', 'gate.log');
/** 本次运行的 .partial（带 pid，严格检查 2026-10-10：两次门禁同时跑时各写各的）。 */
const partials = (log: string): string[] =>
  readdirSync(dirname(log)).filter(
    (f) => f.startsWith(`${basename(log)}.`) && f.endsWith('.partial'),
  );
const lastLine = (p: string): string => readFileSync(p, 'utf8').trimEnd().split('\n').at(-1) ?? '';

describe('runLogged', () => {
  it('🔴 失败的命令：日志尾行是它的真实退出码，返回同一个码；之前的输出都在日志里', async () => {
    const log = logIn();
    const code = await runLogged(
      node,
      ['-e', 'console.log("step 1 ok"); console.error("1 failed"); process.exit(3)'],
      log,
      quiet,
    );
    expect(code).toBe(3);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('step 1 ok');
    expect(text).toContain('1 failed');
    expect(lastLine(log)).toBe('gate-exit=3');
  });

  it('🔴 成功的命令：尾行 gate-exit=0、返回 0；输出最后一行即使像"gate-exit=…"也不会被当成结果', async () => {
    const log = logIn();
    const code = await runLogged(node, ['-e', 'console.log("gate-exit=7")'], log, quiet);
    expect(code).toBe(0);
    const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
    expect(lines.at(-1)).toBe('gate-exit=0');
    expect(lines.at(-2)).toBe('gate-exit=7');
  });

  it('命令根本起不来（不存在的可执行文件）→ 非 0，且尾行照样写出', async () => {
    const log = logIn();
    const code = await runLogged(join(tmpdir(), 'definitely-not-a-binary-xyz'), [], log, quiet);
    expect(code).not.toBe(0);
    expect(lastLine(log)).toMatch(/^gate-exit=\d+$/);
    expect(lastLine(log)).not.toBe('gate-exit=0');
  });

  it('🔴 跑的过程中日志**不在**正式路径上（写在 .partial，结束才改名）；上一轮的旧日志一开跑就删掉', async () => {
    // 三端联动模拟（2026-10-10）：门禁跑到一半去 `tail -1 .gate/gate.log`，读到的是本文件第二条用例
    // 子进程打印的 "gate-exit=7"——中途读日志的尾行长得和结论一模一样。
    const log = logIn();
    const pending = runLogged(
      node,
      ['-e', 'setTimeout(() => console.log("late"), 300)'],
      log,
      quiet,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(log)).toBe(false);
    expect(partials(log)).toHaveLength(1);
    expect(await pending).toBe(0);
    expect(existsSync(log)).toBe(true);
    expect(partials(log)).toEqual([]);
    expect(lastLine(log)).toBe('gate-exit=0');

    writeFileSync(log, 'old\ngate-exit=0\n');
    const second = runLogged(node, ['-e', 'setTimeout(() => process.exit(2), 300)'], log, quiet);
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(log)).toBe(false); // 旧的"gate-exit=0"不能在新一轮跑的时候还躺在那里
    expect(await second).toBe(2);
    expect(lastLine(log)).toBe('gate-exit=2');
  });

  it('🔴 echo: false 时不往本进程的 stdout / stderr 写（日志照写）', async () => {
    const log = logIn();
    const out: string[] = [];
    const ow = process.stdout.write.bind(process.stdout);
    const ew = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((b: string | Uint8Array) => (
      out.push(String(b)),
      true
    )) as typeof process.stdout.write;
    process.stderr.write = ((b: string | Uint8Array) => (
      out.push(String(b)),
      true
    )) as typeof process.stderr.write;
    try {
      await runLogged(
        node,
        ['-e', 'console.log("gate-exit=7"); console.error("noise")'],
        log,
        quiet,
      );
    } finally {
      process.stdout.write = ow;
      process.stderr.write = ew;
    }
    expect(out.join('')).not.toContain('gate-exit=7');
    expect(out.join('')).not.toContain('noise');
    expect(readFileSync(log, 'utf8')).toContain('gate-exit=7\n');
  });

  it('🔴 改名失败（.partial 被别的进程拿走）→ 不抛未捕获异常，照常返回真实退出码（严格检查 2026-10-10）', async () => {
    const log = logIn();
    const pending = runLogged(node, ['-e', 'setTimeout(() => process.exit(4), 300)'], log, quiet);
    await new Promise((r) => setTimeout(r, 100));
    for (const f of partials(log)) rmSync(`${dirname(log)}/${f}`);
    expect(await pending).toBe(4);
  });
});
