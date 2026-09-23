/**
 * 职责：请求上下文传播的 L0 单测（F5）。
 * 重点验证"异步链穿透"——这是 ALS 唯一的价值所在，也是最容易悄悄失效的地方（await 丢上下文）。
 * @see server/src/context.ts @limitation
 */
import { describe, expect, it } from 'vitest';
import {
  currentContext,
  newTraceId,
  patchContext,
  runWithContext,
  type LogContext,
} from './context.js';

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

  /**
   * 缺陷 #5 的回归护栏。
   * @why 曾经的写法 `{ trace_id: ctx.trace_id ?? randomUUID(), ...ctx }` 里，
   *      展开的 `trace_id: undefined` 会把刚生成的 ID 覆盖掉。这类失效不抛错、不为空字符串，
   *      表现为"日志里没有 trace_id"，在排查线上问题时才会被发现——所以必须在单测层钉死。
   *      测试里用 `as LogContext` 绕过 exactOptionalPropertyTypes，模拟"上游字段就是 undefined"的真实来源
   *      （例如从请求头读到的值是 undefined）。
   */
  it('trace_id 显式传 undefined 时仍然自动生成（不被 undefined 冲掉）', () => {
    runWithContext({ trace_id: undefined } as unknown as LogContext, () => {
      const id = currentContext().trace_id;
      expect(typeof id).toBe('string');
      expect((id as string).length).toBeGreaterThan(10);
    });
  });

  it('其它字段传 undefined 也不会写进 store（避免日志里出现 null/undefined 噪音）', () => {
    runWithContext({ trace_id: 't-1', actor: undefined } as unknown as LogContext, () => {
      expect(currentContext()).toEqual({ trace_id: 't-1' });
    });
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

  it('patch 传 undefined 不会把已有字段清成 undefined（见 @limitation 三）', () => {
    runWithContext({ trace_id: 't-1', actor: 'user' }, () => {
      patchContext({ actor: undefined } as unknown as LogContext);
      expect(currentContext().actor).toBe('user');
    });
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
