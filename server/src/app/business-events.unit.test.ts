/**
 * 职责：`app/business-events.ts` 的单测 + **登记守卫**（OPS3-07）。
 *
 * @why `emit` 出去**没有任何订阅者**的事件是**静默**消失的：不报错、不告警、请求照常成功，
 *      只有"它应该发生的下游"永远不会发生。本仓此前正是这个状态——
 *      `order.dispute_opened` / `order.dispute_closed` 两个事件 emit 了，
 *      `LOGGED_EVENTS` 里没有，`mark-disputed.ts` 的注释却写着"事件会进日志"。
 *      后果是"拒付什么时候落的库"只能从**回调管线**的日志反推，不在业务事件流里。
 * @why 守卫扫**源码**而不是维护第二份名单：第二份名单会和第一份漂移（约束九同型缺陷），
 *      而"新增事件忘了登记"这件事恰恰发生在**改代码的人不记得还有一份名单**的时候。
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBus } from '../ports/events.js';
import type { Logger } from '../logger.js';
import { BUSINESS_EVENT_LOG, LOGGED_EVENTS, registerBusinessEventLog } from './business-events.js';

/** `server/src`（本文件的上一级）。 */
const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    // 只扫源码：测试文件里的事件名是**造的输入**，不是"系统 emit 的事件"
    else if (entry.isFile() && p.endsWith('.ts') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/** 领域事件的 emit 写法统一是 `name: 'order.xxx'`（`payment.` 前缀留给将来）。 */
const EMIT_RE = /name:\s*'((?:order|payment)\.[a-z_]+)'/g;

function emittedEventNames(): string[] {
  const set = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    for (const m of readFileSync(file, 'utf8').matchAll(EMIT_RE)) set.add(m[1]!);
  }
  return [...set].sort();
}

describe('业务事件登记守卫（OPS3-07）', () => {
  it('源码里 emit 的每个事件都在 LOGGED_EVENTS 里登记（emit 无订阅者 = 静默落空）', () => {
    const emitted = emittedEventNames();
    // 自检：扫不到东西 = 正则或路径失效，那这条守卫就成了假绿灯。先证明它真扫到了。
    expect(emitted.length).toBeGreaterThanOrEqual(6);
    expect(emitted).toContain('order.created');
    expect(emitted).toContain('order.dispute_opened');
    expect(emitted).toContain('order.dispute_closed');

    const missing = emitted.filter((n) => !LOGGED_EVENTS.includes(n));
    expect(
      missing,
      `这些事件 emit 了却没登记，会静默消失（在 ${BUSINESS_EVENT_LOG} 里查不到）：${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('LOGGED_EVENTS 里登记的每一个都真的挂上了订阅者（登记 ≠ 生效）', () => {
    const handlers = new Map<string, ((event: unknown) => void)[]>();
    const bus = {
      subscribe(name: string, handler: (event: unknown) => void): void {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
    } as unknown as EventBus;
    const info = vi.fn();
    registerBusinessEventLog(bus, { info } as unknown as Logger);

    // 反向也扫一遍：登记了但没挂上订阅者，日志里同样查不到，且没有任何报错
    for (const name of LOGGED_EVENTS) {
      expect(handlers.get(name), `登记了 ${name} 却没注册订阅者`).toHaveLength(1);
    }

    // 真 emit 一次：日志名与 ctx.domain_event 必须对得上（检索口径）
    for (const name of LOGGED_EVENTS) {
      handlers.get(name)![0]!({
        name,
        orderId: 'o-1',
        at: '2026-01-01T00:00:00.000Z',
        payload: { dispute_id: 'du_1' },
      });
    }
    expect(info).toHaveBeenCalledTimes(LOGGED_EVENTS.length);
    const logged = info.mock.calls.map((c) => (c[1] as { ctx: { domain_event: string } }).ctx);
    expect(logged.map((c) => c.domain_event)).toEqual([...LOGGED_EVENTS]);
    // payload 必须带进去（拒付事件只有它带 dispute_id，丢了就没法按单号检索）
    for (const c of info.mock.calls) {
      expect((c[1] as { ctx: { dispute_id: string } }).ctx.dispute_id).toBe('du_1');
    }
  });

  it('每个登记的事件都走同一个日志名（检索只需一个关键词）', () => {
    const handlers = new Map<string, ((event: unknown) => void)[]>();
    const bus = {
      subscribe(name: string, handler: (event: unknown) => void): void {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as unknown as EventBus;
    const info = vi.fn();
    registerBusinessEventLog(bus, { info } as unknown as Logger);
    for (const name of LOGGED_EVENTS) {
      handlers.get(name)![0]!({ name, orderId: 'o-1', at: '2026-01-01T00:00:00.000Z' });
    }
    for (const call of info.mock.calls) expect(call[0]).toBe(BUSINESS_EVENT_LOG);
  });
});
