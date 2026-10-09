#!/usr/bin/env node
/**
 * 职责：跑一条门禁命令（默认 `npm run gate`），输出同时写屏幕与日志文件；**日志最后一行由本脚本写**
 *      `gate-exit=<被测命令的真实退出码>`，并以同一个退出码结束（统一结论操作律 1 / AJ-423）。
 *
 * @why §2 第 43、106 条：两次把"管道末尾命令（tail / grep）的退出码"当成门禁结果——一次假红、一次假绿。
 *      这里不经过任何管道：退出码取自子进程本身，交付与报告只认日志最后一行。
 * @why 日志写文件而不是只给屏幕：后台运行时会话看不到屏幕，事后要能 `tail -1` 拿到唯一可信的结论。
 * @limitation 一：被测命令自己打印的"gate-exit=…"字样会出现在日志中间——只有**最后一行**是本脚本写的。
 * @limitation 二：不解析通过数；报告里的通过数仍要从日志里 vitest 的汇总行读（H6）。
 *
 * 用法：`npm run gate:log`（日志在 `.gate/gate.log`）；`node scripts/run-gate.mjs --log <路径> -- <命令> [参数…]`。
 * @see CLAUDE.md H6；docs/templates/unit-completion-template.md
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

/**
 * 运行命令并记日志，返回子进程退出码（起不来时为 127）。
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} logPath
 * @returns {Promise<number>}
 */
export function runLogged(cmd, args, logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      log.end(`gate-exit=${String(code)}\n`, () => resolve(code));
    };
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => {
      process.stdout.write(b);
      log.write(b);
    });
    child.stderr.on('data', (b) => {
      process.stderr.write(b);
      log.write(b);
    });
    child.on('error', (e) => {
      log.write(`无法启动：${e.message}\n`);
      finish(127);
    });
    child.on('close', (code, signal) => finish(code ?? (signal !== null ? 128 : 1)));
  });
}

if (isMain(import.meta.url, process.argv[1])) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  const li = argv.indexOf('--log');
  const logPath = li >= 0 ? argv[li + 1] : join(root, '.gate', 'gate.log');
  const sep = argv.indexOf('--');
  const [cmd, ...args] = sep >= 0 ? argv.slice(sep + 1) : ['npm', 'run', 'gate'];
  process.exit(await runLogged(cmd, args, logPath));
}
