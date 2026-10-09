/**
 * 小程序前端报错 → 微信实时日志（AJ-421）：脱敏、去重、限量、截断，以及 app.js 的两个全局钩子确实接上了。
 *
 * @why 接线用例把 app.js 真加载一遍（桩掉全局 App / wx）：只测 utils 的话，app.js 漏挂 onError 也是全绿。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorLog, maskErrorText } from './client-error.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('maskErrorText', () => {
  it('🔴 邮箱、国际电话、长数字串打码；普通调用栈原样', () => {
    expect(maskErrorText('bad recipient jane.doe@example.com')).toBe(
      'bad recipient j***@example.com',
    );
    expect(maskErrorText('phone +14155550123 invalid')).toBe('phone ***0123 invalid');
    expect(maskErrorText('card 4242424242424242 declined')).toBe('card ***4242 declined');
    expect(
      maskErrorText(
        "TypeError: Cannot read properties of undefined (reading 'items')\n    at t (pages/cart/index.js:120:13)",
      ),
    ).toBe(
      "TypeError: Cannot read properties of undefined (reading 'items')\n    at t (pages/cart/index.js:120:13)",
    );
  });
});

describe('createErrorLog', () => {
  function setup(max?: number) {
    const lines: unknown[][] = [];
    const log = createErrorLog({
      logger: () => ({ error: (...a: unknown[]) => lines.push(a) }),
      ...(max === undefined ? {} : { maxPerLaunch: max }),
    });
    return { lines, log };
  }

  it('🔴 记一条：事件名 client_error，内容是脱敏后的 JSON（kind / message / stack）', () => {
    const { lines, log } = setup();
    log.record('error', 'MiniProgramError\nfailed for jane.doe@example.com');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[0]).toBe('client_error');
    const body = JSON.parse(String(lines[0]?.[1])) as Record<string, unknown>;
    expect(body).toEqual({
      kind: 'error',
      message: 'MiniProgramError\nfailed for j***@example.com',
    });
  });

  it('🔴 拒绝原因是 Error：取 message 与 stack；同一消息只记一次；每次启动最多 N 条', () => {
    const { lines, log } = setup(2);
    const e = new Error('async load broke');
    log.record('rejection', e);
    log.record('rejection', e);
    log.record('error', 'second');
    log.record('error', 'third');
    expect(lines.map((l) => (JSON.parse(String(l[1])) as { message: string }).message)).toEqual([
      'async load broke',
      'second',
    ]);
    const first = JSON.parse(String(lines[0]?.[1])) as Record<string, unknown>;
    expect(first['kind']).toBe('rejection');
    expect(typeof first['stack']).toBe('string');
  });

  it('实时日志不可用（低版本 / 开发者工具未开）→ 静默，不抛', () => {
    const log = createErrorLog({ logger: () => undefined });
    expect(() => log.record('error', 'x')).not.toThrow();
  });
});

describe('app.js 接线', () => {
  it('🔴 App 的 onError / onUnhandledRejection 都把报错写进实时日志', async () => {
    const errors: unknown[][] = [];
    let def: Record<string, (...a: unknown[]) => unknown> | undefined;
    vi.resetModules();
    vi.stubGlobal('wx', {
      getRealtimeLogManager: () => ({ error: (...a: unknown[]) => errors.push(a) }),
    });
    vi.stubGlobal('App', (d: Record<string, (...a: unknown[]) => unknown>) => {
      def = d;
    });
    await import('../app.js');
    def?.['onError']?.('TypeError: x is undefined\n    at onShow (pages/home/index.js:10:3)');
    def?.['onUnhandledRejection']?.({
      reason: new Error('quote failed'),
      promise: Promise.resolve(),
    });
    expect(
      errors.map((e) => JSON.parse(String(e[1])) as { kind: string; message: string }),
    ).toEqual([
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('x is undefined') as string,
      }),
      expect.objectContaining({ kind: 'rejection', message: 'quote failed' }),
    ]);
  });
});
