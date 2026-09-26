/**
 * 职责：领域事件总线的 L0 单测（R2-2）。
 *
 * @why R2-2 的两条验收里有一条完全落在这里：**订阅者抛错不影响发布方**。
 *      这条不测就等于没做——因为"订阅者抛错"在生产里是常态（网络、下游、空指针），
 *      而它的失败形态最恶劣：用户已经下单成功，却因为一个埋点订阅者收到 500。
 *
 * @how 用 MemorySink 收日志，断言"失败留痕"而不只是"没抛错"——
 *      只断言"没抛错"的话，把实现写成 `try {} catch {}`（静默吞掉）也能全绿，
 *      那正是本项目最忌讳的一类假绿。
 */
import { describe, expect, it } from 'vitest';
import { createEventBus } from './event-bus.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import type { DomainEvent } from '../ports/events.js';

const busWithSink = () => {
  const sink = new MemorySink();
  const bus = createEventBus(createLogger({ env: 'development', destination: sink }));
  return { bus, sink };
};

const ev = (name: string, orderId = 'sk-1'): DomainEvent => ({
  name,
  at: '2026-09-24T00:00:00.000Z',
  orderId,
});

describe('事件总线：基本分发', () => {
  it('订阅者收到事件，且多个订阅者按注册顺序都收到', () => {
    const { bus } = busWithSink();
    const seen: string[] = [];
    bus.subscribe('order.created', () => seen.push('a'));
    bus.subscribe('order.created', () => seen.push('b'));
    bus.publish(ev('order.created'));
    expect(seen).toEqual(['a', 'b']);
  });

  it('没有订阅者的事件：发布不报错（新事件先发布、后有人订阅是合法顺序）', () => {
    const { bus, sink } = busWithSink();
    expect(() => bus.publish(ev('order.nobody'))).not.toThrow();
    expect(sink.rows()).toHaveLength(0);
  });

  it('只订阅了别的名字 → 收不到（按事件名精确匹配，不做通配符）', () => {
    const { bus } = busWithSink();
    let hit = 0;
    bus.subscribe('order.paid', () => (hit += 1));
    bus.publish(ev('order.created'));
    expect(hit).toBe(0);
  });
});

describe('事件总线：失败隔离（R2-2 验收一）', () => {
  it('订阅者抛错 → publish 不抛，且发布方后续代码继续执行', () => {
    const { bus } = busWithSink();
    bus.subscribe('order.created', () => {
      throw new Error('subscriber boom');
    });
    let after = false;
    expect(() => bus.publish(ev('order.created'))).not.toThrow();
    after = true;
    expect(after).toBe(true);
  });

  it('一个订阅者抛错 → 其它订阅者仍然收到（不能把埋点故障放大成发货通知丢失）', () => {
    const { bus } = busWithSink();
    const seen: string[] = [];
    bus.subscribe('order.created', () => {
      throw new Error('first boom');
    });
    bus.subscribe('order.created', () => seen.push('second'));
    bus.subscribe('order.created', () => seen.push('third'));
    bus.publish(ev('order.created'));
    expect(seen).toEqual(['second', 'third']);
  });

  it('抛错**必须**留 error 日志（静默吞掉不算隔离）', () => {
    const { bus, sink } = busWithSink();
    bus.subscribe('order.paid', () => {
      throw new Error('pay subscriber boom');
    });
    bus.publish(ev('order.paid', 'sk-9'));

    const rows = sink.find('domain_event_subscriber_failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.err).toBe('pay subscriber boom');
    expect(rows[0]?.order_id).toBe('sk-9');
    // 领域事件名放在 ctx：写 `event:` 会被 logger 静默丢弃（logger.ts SILENT_DROP_KEYS）
    const ctx = rows[0]?.ctx as Record<string, unknown> | undefined;
    expect(ctx?.domain_event).toBe('order.paid');
  });

  it('订阅者抛的**非 Error** 值 → err 字段是 String(reason)（`instanceof` 另一支）', () => {
    const { bus, sink } = busWithSink();
    bus.subscribe('order.created', () => {
      throw 'string-boom';
    });
    bus.publish(ev('order.created'));
    expect(sink.find('domain_event_subscriber_failed')[0]?.err).toBe('string-boom');
  });
});

describe('事件总线：async 订阅者（三审 P2-1）', () => {
  /**
   * @why 通知/发券/发货指令天然是网络调用，订阅者迟早会是 async。旧实现只 try/catch 同步异常，
   *      async 订阅者的 rejection 逃出总线 → 被 N25 的 unhandledRejection 兜底判成 fatal →
   *      整个 web 进程优雅停机（一次通知服务抖动 = 一次发布事故）。
   *      "永不抛错、单个订阅者失败不影响其它"这两条承诺必须对 async 同样成立。
   */
  it('async 订阅者 reject → 只记 subscriber_failed，不泄漏成 unhandledRejection，其它订阅者照常', async () => {
    const { bus, sink } = busWithSink();
    const seen: string[] = [];
    bus.subscribe('order.paid', async () => {
      await Promise.resolve();
      throw new Error('boom-async');
    });
    bus.subscribe('order.paid', () => {
      seen.push('sync-ok');
    });
    bus.publish(ev('order.paid', 'sk-async'));
    // 让 rejection 走完微任务队列（若未被总线接住，vitest 会以 Unhandled Rejection 判红）
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['sync-ok']);
    const rows = sink.find('domain_event_subscriber_failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.err).toBe('boom-async');
    expect(rows[0]?.order_id).toBe('sk-async');
  });
});

describe('事件总线：退订与批量', () => {
  it('退订后收不到；重复退订无副作用（幂等）', () => {
    const { bus } = busWithSink();
    let hit = 0;
    const off = bus.subscribe('order.created', () => (hit += 1));
    bus.publish(ev('order.created'));
    expect(hit).toBe(1);
    off();
    off(); // 幂等：第二次不该报错，也不该误删别人
    bus.publish(ev('order.created'));
    expect(hit).toBe(1);
  });

  it('同一个 handler 重复订阅只生效一次（Set 去重——重复注册会导致"邮件发两封"）', () => {
    const { bus } = busWithSink();
    let hit = 0;
    const handler = () => (hit += 1);
    bus.subscribe('order.created', handler);
    bus.subscribe('order.created', handler);
    bus.publish(ev('order.created'));
    expect(hit).toBe(1);
  });

  it('publishAll 按数组顺序分发（顺序错了，订阅者看到的因果关系就是反的）', () => {
    const { bus } = busWithSink();
    const seen: string[] = [];
    bus.subscribe('order.created', (e) => seen.push(`created:${e.orderId ?? ''}`));
    bus.subscribe('order.paid', (e) => seen.push(`paid:${e.orderId ?? ''}`));
    bus.publishAll([ev('order.created', 'sk-a'), ev('order.paid', 'sk-b')]);
    expect(seen).toEqual(['created:sk-a', 'paid:sk-b']);
  });

  it('订阅者在分发过程中再订阅 → 本次不漏发也不重发（遍历的是快照）', () => {
    const { bus } = busWithSink();
    const seen: string[] = [];
    bus.subscribe('order.created', () => {
      seen.push('first');
      bus.subscribe('order.created', () => seen.push('late'));
    });
    bus.publish(ev('order.created'));
    expect(seen).toEqual(['first']); // 新订阅者不参与本次分发
    bus.publish(ev('order.created'));
    expect(seen).toEqual(['first', 'first', 'late']);
  });

  it('publishAll 被解构出去单独调用仍然可用（实现里不能用 this）', () => {
    const { bus } = busWithSink();
    let hit = 0;
    bus.subscribe('order.created', () => (hit += 1));
    const { publishAll } = bus;
    publishAll([ev('order.created')]);
    expect(hit).toBe(1);
  });
});
