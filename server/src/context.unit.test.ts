/**
 * 职责：请求上下文传播的 L0 单测（F5）。
 * 重点验证"异步链穿透"——这是 ALS 唯一的价值所在，也是最容易悄悄失效的地方（await 丢上下文）。
 * @see server/src/context.ts @limitation
 */
import { describe, expect, it } from 'vitest';
import { currentContext, newTraceId, patchContext, runWithContext } from './context.js';

describe('runWithContext', () => {
  it('同步与 await 之后上下文依然在（异步链穿透）', async () => {
    await runWithContext({ trace_id: 't-1', actor: 'user' }, async () => {
      expect(currentContext().trace_id).toBe('t-1');
      await new Promise((r) => setTimeout(r, 1));
      expect(currentContext().trace_id).toBe('t-1');
      await Promise.resolve();
      expect(currentContext().actor).toBe('user');
    });
  });

  it('嵌套可覆盖，退出后恢复外层（回调里换 actor 不能污染外层）', () => {
    runWithContext({ trace_id: 'outer', actor: 'user' }, () => {
      runWithContext({ trace_id: 'inner', actor: 'system' }, () => {
        expect(currentContext()).toEqual({ trace_id: 'inner', actor: 'system' });
      });
      expect(currentContext().actor).toBe('user');
    });
  });

  it('并发的多个上下文互不串扰（两个请求同时处理时 trace_id 不能混）', async () => {
    const results = await Promise.all(
      ['A', 'B', 'C'].map((name) =>
        runWithContext({ trace_id: name }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return currentContext().trace_id;
        }),
      ),
    );
    expect(results).toEqual(['A', 'B', 'C']);
  });

  it('上下文外返回空对象而不是 undefined（调用点不必判空）', () => {
    expect(currentContext()).toEqual({});
  });
});

describe('patchContext', () => {
  it('登录成功后补充 user_id，链上可见', () => {
    runWithContext({ trace_id: 't-1' }, () => {
      patchContext({ user_id: 'u-9' });
      expect(currentContext().user_id).toBe('u-9');
      expect(currentContext().trace_id).toBe('t-1');
    });
  });

  it('无上下文时 patch 不抛错（定时任务里可能没有上下文）', () => {
    expect(() => patchContext({ actor: 'system' })).not.toThrow();
  });
});

describe('newTraceId', () => {
  it('每次不同且非空白', () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });
});
