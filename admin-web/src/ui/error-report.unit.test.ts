/**
 * 前端报错上报器（AJ-421）：去重、限量、截断、发送失败不外抛。
 */
import { describe, expect, it } from 'vitest';
import {
  REPORT_MESSAGE_MAX,
  REPORT_STACK_MAX,
  createErrorReporter,
  describeThrown,
} from './error-report.js';

function setup(opts: { maxPerLoad?: number; fail?: boolean } = {}) {
  const sent: Array<Record<string, string>> = [];
  const reporter = createErrorReporter({
    send: async (b) => {
      sent.push(b);
      if (opts.fail === true) throw new Error('network');
    },
    ...(opts.maxPerLoad === undefined ? {} : { maxPerLoad: opts.maxPerLoad }),
  });
  return { sent, reporter };
}

describe('createErrorReporter', () => {
  it('🔴 同一消息只报一次（含 React 开发模式把接住的渲染错误再派发成 window error）；不同消息各报；请求体就是这几个键', () => {
    const { sent, reporter } = setup();
    reporter.report({ kind: 'render', message: 'boom', stack: 'at A', page: 'orders' });
    reporter.report({ kind: 'render', message: 'boom', stack: 'at B', page: 'orders' });
    reporter.report({ kind: 'error', message: 'boom' });
    reporter.report({ kind: 'rejection', message: 'other' });
    expect(sent).toEqual([
      { kind: 'render', message: 'boom', stack: 'at A', page: 'orders' },
      { kind: 'rejection', message: 'other' },
    ]);
  });

  it('🔴 每次加载最多报 maxPerLoad 条（源头限量，服务端不限频）', () => {
    const { sent, reporter } = setup({ maxPerLoad: 3 });
    for (let i = 0; i < 10; i += 1) reporter.report({ kind: 'error', message: `e${String(i)}` });
    expect(sent.map((b) => b['message'])).toEqual(['e0', 'e1', 'e2']);
  });

  it('🔴 截断到服务端上限；页名不合形状就不带；空消息不报', () => {
    const { sent, reporter } = setup();
    reporter.report({
      kind: 'error',
      message: `  ${'x'.repeat(REPORT_MESSAGE_MAX + 50)}  `,
      stack: 's'.repeat(REPORT_STACK_MAX + 50),
      page: 'Orders/1',
    });
    reporter.report({ kind: 'error', message: '   ' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.['message']).toHaveLength(REPORT_MESSAGE_MAX);
    expect(sent[0]?.['stack']).toHaveLength(REPORT_STACK_MAX);
    expect(sent[0]).not.toHaveProperty('page');
  });

  it('发送失败不外抛（上报失败不能变成新的报错）', async () => {
    const { reporter } = setup({ fail: true });
    expect(() => reporter.report({ kind: 'error', message: 'x' })).not.toThrow();
    await Promise.resolve();
  });
});

describe('describeThrown', () => {
  it('Error / 字符串 / 对象 / 循环对象都能变成一句消息', () => {
    expect(describeThrown(new TypeError('bad')).message).toBe('bad');
    expect(describeThrown('plain').message).toBe('plain');
    expect(describeThrown({ code: 40001 }).message).toBe('{"code":40001}');
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(describeThrown(loop).message).toBe('[object Object]');
  });
});
