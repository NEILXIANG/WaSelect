/**
 * 职责：组装根的 L0 单测——只覆盖**不需要数据库**的纯函数（A1）。
 * 需要真库的部分在 main.db.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { ConfigError } from './config.js';
import { formatStartupError } from './main.js';

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
