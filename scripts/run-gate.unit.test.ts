/**
 * 门禁运行器（统一结论操作律 1 / AJ-423）：日志最后一行由运行器自己写 `gate-exit=<被测命令的真实退出码>`，
 * 且运行器以同一个退出码结束。
 *
 * @why §2 第 43 / 106 条：两次把"管道末尾命令的退出码"当成门禁结果。运行器不经管道取退出码，
 *      交付与报告只认它写下的最后一行。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLogged } from './run-gate.mjs';

const node = process.execPath;
const logIn = (): string => join(mkdtempSync(join(tmpdir(), 'run-gate-')), 'nested', 'gate.log');
const lastLine = (p: string): string => readFileSync(p, 'utf8').trimEnd().split('\n').at(-1) ?? '';

describe('runLogged', () => {
  it('🔴 失败的命令：日志尾行是它的真实退出码，返回同一个码；之前的输出都在日志里', async () => {
    const log = logIn();
    const code = await runLogged(
      node,
      ['-e', 'console.log("step 1 ok"); console.error("1 failed"); process.exit(3)'],
      log,
    );
    expect(code).toBe(3);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('step 1 ok');
    expect(text).toContain('1 failed');
    expect(lastLine(log)).toBe('gate-exit=3');
  });

  it('🔴 成功的命令：尾行 gate-exit=0、返回 0；输出最后一行即使像"gate-exit=…"也不会被当成结果', async () => {
    const log = logIn();
    const code = await runLogged(node, ['-e', 'console.log("gate-exit=7")'], log);
    expect(code).toBe(0);
    const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
    expect(lines.at(-1)).toBe('gate-exit=0');
    expect(lines.at(-2)).toBe('gate-exit=7');
  });

  it('命令根本起不来（不存在的可执行文件）→ 非 0，且尾行照样写出', async () => {
    const log = logIn();
    const code = await runLogged(join(tmpdir(), 'definitely-not-a-binary-xyz'), [], log);
    expect(code).not.toBe(0);
    expect(lastLine(log)).toMatch(/^gate-exit=\d+$/);
    expect(lastLine(log)).not.toBe('gate-exit=0');
  });
});
