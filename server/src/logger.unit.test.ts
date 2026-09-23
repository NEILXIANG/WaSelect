/**
 * 职责：运行日志（流 A）的 L0 单测（F5）。
 * 用内存 sink 捕获真实 pino 输出（不 mock 掉 pino——日志格式正是要验的东西）。
 * @see docs/代码注释规范与日志体系设计.md（统一字段）；docs/地基搭建清单.md F5
 */
import { describe, expect, it } from 'vitest';
import { createLogger, levelForEnv, type Logger } from './logger.js';
import { currentContext, runWithContext } from './context.js';
import { MemorySink, type LogRow } from '../../test/helpers/memory-sink.js';

function setup(env: 'development' | 'staging' | 'production' = 'development'): {
  sink: MemorySink;
  log: Logger;
} {
  const sink = new MemorySink();
  const log = createLogger({ env, destination: sink, base: { version: '0.0.0' } });
  return { sink, log };
}

describe('输出形状', () => {
  it('每行是合法 JSON，含统一字段', () => {
    const { sink, log } = setup();
    log.info('order_created', { order_id: 'W20260922-000001', duration_ms: 12 });
    const row: LogRow = sink.last();
    expect(row.event).toBe('order_created');
    expect(row.order_id).toBe('W20260922-000001');
    expect(row.duration_ms).toBe(12);
    expect(row.level).toBe('info');
    expect(row.service).toBe('waselect-server');
    expect(row.version).toBe('0.0.0');
    expect(typeof row.ts).toBe('string');
    expect(new Date(row.ts as string).toString()).not.toBe('Invalid Date');
  });

  it('event 为空 / 非字符串直接抛错——事件名是聚合维度，不能静默记成 undefined', () => {
    const { log } = setup();
    expect(() => log.info('')).toThrow(TypeError);
    expect(() => log.info('   ')).toThrow(TypeError);
    expect(() => log.info(123 as unknown as string)).toThrow(TypeError);
  });
});

describe('上下文自动注入（ALS）', () => {
  it('runWithContext 内的日志自动带上 trace_id / order_id', () => {
    const { sink, log } = setup();
    runWithContext({ trace_id: 'trace-1', order_id: 'W1', module: 'payment' }, () => {
      log.info('pay_started', { channel: 'stripe' });
    });
    const row: LogRow = sink.last();
    expect(row.trace_id).toBe('trace-1');
    expect(row.order_id).toBe('W1');
    expect(row.module).toBe('payment');
    expect(row.channel).toBe('stripe');
  });

  it('上下文之外不留痕（不会串到下一个请求）', () => {
    const { sink, log } = setup();
    runWithContext({ trace_id: 'trace-1' }, () => log.info('inside'));
    log.info('outside');
    expect(sink.last().trace_id).toBeUndefined();
    expect(currentContext()).toEqual({});
  });

  it('未显式给 trace_id 时自动生成一个，保证有上下文就一定有 trace_id', () => {
    const { sink, log } = setup();
    runWithContext({ actor: 'system' }, () => log.info('job_tick'));
    expect(typeof sink.last().trace_id).toBe('string');
    expect((sink.last().trace_id as string).length).toBeGreaterThan(10);
  });
});

describe('脱敏在日志出口强制生效', () => {
  it('卡号 / 邮箱不会以明文出现在日志里', () => {
    const { sink, log } = setup();
    log.error('pay_failed', { card: '4242424242424242', email: 'hanako@example.com' });
    const raw = sink.lines.join('\n');
    expect(raw).not.toContain('4242424242424242');
    expect(raw).not.toContain('hanako@');
  });

  it('Error 作为字段被摊平，便于按 err_message 检索', () => {
    const { sink, log } = setup();
    log.error('db_query_failed', { err: new Error('connection refused') });
    const err = sink.last().err as Record<string, unknown>;
    expect(err.err_type).toBe('Error');
    expect(err.err_message).toBe('connection refused');
  });
});

/**
 * 缺陷 #3/#4 的回归护栏。
 * @why 这两个缺陷的共同点是"输出里**有**脱敏后的值，所以按值断言能过"——明文是作为**重复键**
 *      追加在同一行 JSON 里的，`JSON.parse` 取最后一个键，恰好取到明文。
 *      因此这里除了断言"明文不出现"，还必须断言"同一行里同一个键只出现一次"。
 */
describe('脱敏护栏：child 与上下文（缺陷 #3/#4）', () => {
  /** 统计某个顶层键在**原始 JSON 文本**里出现的次数——重复键只能靠文本层发现。 */
  function countKey(line: string, key: string): number {
    return line.split(`"${key}":`).length - 1;
  }

  it('child 传进来的敏感值不会以明文出现，且不产生重复键', () => {
    const { sink, log } = setup();
    const pay = log.child({ module: 'payment', token: 'sk_live_plain', card: '4242424242424242' });
    pay.info('provider_called');

    const line = sink.lines[0] ?? '';
    expect(line).not.toContain('sk_live_plain');
    expect(line).not.toContain('4242424242424242');
    expect(countKey(line, 'token')).toBe(1);
    expect(countKey(line, 'card')).toBe(1);
    // 脱敏后仍要保留可关联性（后 4 位），否则排障时无法把多次报错串起来
    expect(sink.last().card).toBe('***4242');
    expect(sink.last().module).toBe('payment');
  });

  it('child 再 child（多层派生）也不会漏脱敏', () => {
    const { sink, log } = setup();
    const deep = log
      .child({ module: 'payment' })
      .child({ channel: 'stripe' })
      .child({ api_key: 'sk_test_deep' });
    deep.info('nested');
    expect(sink.lines.join('\n')).not.toContain('sk_test_deep');
  });

  it('上下文里的 actor 邮箱被脱敏（键名不敏感、值敏感）', () => {
    const { sink, log } = setup();
    runWithContext({ actor: 'admin:bob@example.com', user_id: 'u-1' }, () => {
      log.info('admin_action');
    });
    const line = sink.lines[0] ?? '';
    expect(line).not.toContain('bob@');
    expect(sink.last().actor).toBe('admin:b***@example.com');
  });

  it('上下文与调用点字段都不会绕过脱敏（同一行内不出现重复键）', () => {
    const { sink, log } = setup();
    runWithContext({ actor: 'admin:bob@example.com' }, () => {
      log.info('admin_action', { token: 'sk_live_plain' });
    });
    const line = sink.lines[0] ?? '';
    expect(countKey(line, 'actor')).toBe(1);
    expect(countKey(line, 'token')).toBe(1);
    expect(line).not.toContain('bob@');
    expect(line).not.toContain('sk_live_plain');
  });
});

/** 缺陷 #6：事件名必须不可被调用点字段改写。 */
describe('event 不可被覆盖（缺陷 #6）', () => {
  it('调用点传 `{ event: ... }` 不能改写事件名', () => {
    const { sink, log } = setup();
    log.info('order_created', { event: 'hijacked' });
    expect(sink.last().event).toBe('order_created');
  });

  it('child 绑定里写 event 也不能改写事件名', () => {
    const { sink, log } = setup();
    log.child({ event: 'from_child' }).info('order_created');
    expect(sink.last().event).toBe('order_created');
  });
});

/** 字段优先级必须显式、可测，否则后来者会靠猜。 */
describe('字段优先级', () => {
  it('业务维度：调用点 > 请求上下文 > child 绑定；module 反过来（child 最优先）', () => {
    const { sink, log } = setup();
    const child = log.child({ module: 'payment', channel: 'mock' });
    runWithContext({ channel: 'wechat', module: 'ctx-module' }, () => {
      child.info('pay_started', { channel: 'stripe' });
    });
    const row = sink.last();
    // channel 是业务维度：调用点最具体，赢
    expect(row.channel).toBe('stripe');
    // module 是归属维度：child 绑定（写这行代码的模块）赢过上下文（传输层）
    expect(row.module).toBe('payment');
    expect(row.event).toBe('pay_started');
  });

  it('order_id 允许由调用点给出——下单那一刻上下文里还没有它', () => {
    const { sink, log } = setup();
    runWithContext({ trace_id: 't1' }, () => {
      log.info('order_created', { order_id: 'W20260922-000001' });
    });
    const row = sink.last();
    expect(row.order_id).toBe('W20260922-000001');
    expect(row.trace_id).toBe('t1');
  });
});

/**
 * D8 / D9：调用点不得改写"身份与归属"字段。
 *
 * @why 这两条都属于"日志本身被污染"，比"日志少记了"更危险：
 *      排障时按 trace_id 串链、按 user_id 追责、按 module 过滤，
 *      任意一行代码能改写这些字段，等于让日志系统自己说谎——而且**看不出来**。
 */
describe('保留字段不可被调用点改写（D8 / D9）', () => {
  it('D8：调用点传 trace_id / user_id 不能改写链路与归属', () => {
    const { sink, log } = setup('production'); // 生产走"改名留痕"，不抛错
    runWithContext({ trace_id: 'trace-real', user_id: 'u-real' }, () => {
      log.info('pay_started', { trace_id: 'FORGED', user_id: 'u-fake' });
    });
    const row = sink.last();
    expect(row.trace_id).toBe('trace-real');
    expect(row.user_id).toBe('u-real');
    // 被丢弃的值不死掉，改名留下：既不污染聚合字段，也不丢排查线索
    expect(row.field_trace_id).toBe('FORGED');
    expect(row.field_user_id).toBe('u-fake');
    expect(row.reserved_dropped).toEqual(['trace_id', 'user_id']);
  });

  it('D9：module 由 child 绑定决定，不被请求上下文覆盖', () => {
    const { sink, log } = setup();
    const payment = log.child({ module: 'payment' });
    runWithContext({ module: 'http' }, () => {
      payment.info('provider_called');
    });
    // 修好前这里会是 "http"：请求内所有模块都被记成 http，按模块过滤彻底失效
    expect(sink.last().module).toBe('payment');
  });

  it('非生产：调用点传保留键直接抛错——早炸比上线后静默污染好', () => {
    const { log } = setup('development');
    expect(() => log.info('pay_started', { trace_id: 'FORGED' })).toThrow(/保留键/);
    expect(() => log.info('pay_started', { module: 'whatever' })).toThrow(/保留键/);
  });

  it('生产：不改行为、不让请求失败（一条日志不该让下单挂掉）', () => {
    const { sink, log } = setup('production');
    expect(() => log.info('pay_started', { trace_id: 'FORGED' })).not.toThrow();
    expect(sink.lines).toHaveLength(1);
  });

  /**
   * N23：staging 必须与生产同行为（改名留痕），而非与开发同行为（抛错）。
   * @why 预发存在的全部意义是**预演生产路径**——它接真实渠道、跑真实数据彩排。
   *      若 staging 对保留键抛错，等于预发跑的不是生产那套代码路径：
   *      彩排时把请求打挂（监控害死业务的预演版），或更糟——彩排没踩到的违规
   *      上线后以另一种行为出现。要"早炸"有 development/test 两层，不需要第三层。
   */
  it('N23：staging 与生产同行为——保留键改名留痕、不抛错', () => {
    const { sink, log } = setup('staging');
    expect(() => log.info('pay_started', { trace_id: 'FORGED' })).not.toThrow();
    const row = sink.last();
    expect(row.trace_id).toBeUndefined();
    expect(row.field_trace_id).toBe('FORGED');
    expect(row.reserved_dropped).toEqual(['trace_id']);
  });

  it('N23：严格模式只剩 development / test 两层（早炸留给真正的开发环）', () => {
    const { log: devLog } = setup('development');
    expect(() => devLog.info('x', { trace_id: 'F' })).toThrow(/保留键/);
    const testSink = new MemorySink();
    const testLog = createLogger({ env: 'test', destination: testSink });
    expect(() => testLog.info('x', { trace_id: 'F' })).toThrow(/保留键/);
  });

  it('非保留键照常由调用点决定（order_id 之外的业务字段不受影响）', () => {
    const { sink, log } = setup();
    log.info('order_created', { attempt: 2, provider: 'stripe' });
    const row = sink.last();
    expect(row.attempt).toBe(2);
    expect(row.provider).toBe('stripe');
  });
});

/**
 * N30：child() 的绑定字段过去**不过 splitReserved**——调用点有守卫、child 没有，
 * 等于在身份字段的防线上留了一扇没锁的门。
 *
 * @why 这条在无请求上下文的地方最危险（调度器、启动期、脚本）：那里没有上下文中间件
 *      写入 trace_id，`log.child({ trace_id: 'FORGED' })` 的伪造值会原样落在每一行日志上，
 *      而 emit 里"上下文覆盖 base"的优先级规则救不了场（没有上下文可覆盖）。
 *      修好前这些测试全红：child 想绑什么身份就绑什么，日志系统无法察觉。
 *
 * 策略与调用点一致：非生产抛错早炸，生产改名留痕不炸请求。
 * 唯一差异：child 有**合法身份通道**（见 logger.ts CHILD_BINDABLE_KEYS 的 @why）。
 */
describe('child 的身份字段约束（N30）', () => {
  it('非生产：child 传 trace_id / user_id 直接抛错', () => {
    const { log } = setup('development');
    expect(() => log.child({ trace_id: 'FORGED' })).toThrow(/保留键/);
    expect(() => log.child({ user_id: 'u-fake' })).toThrow(/保留键/);
    expect(() => log.child({ ts: 0 })).toThrow(/保留键/);
  });

  it('生产：child 传保留键不炸请求，但伪造值被改名、留痕可检索', () => {
    const { sink, log } = setup('production');
    const child = log.child({ trace_id: 'FORGED', module: 'payment' });
    child.info('provider_called');
    const row = sink.last();
    // 无上下文时伪造值绝不能出现在聚合字段上（修好前这里会是 FORGED）
    expect(row.trace_id).toBeUndefined();
    expect(row.field_trace_id).toBe('FORGED');
    expect(row.reserved_dropped).toEqual(['trace_id']);
    // module 是 child 的合法绑定通道（D9），不受影响
    expect(row.module).toBe('payment');
  });

  it('child 可合法绑定 module / actor——无上下文处（调度器）确立归属的唯一通道', () => {
    const { sink, log } = setup('development');
    const sched = log.child({ module: 'scheduler', actor: 'scheduler' });
    sched.info('job_started', { job: 'order-expiry' });
    const row = sink.last();
    expect(row.module).toBe('scheduler');
    expect(row.actor).toBe('scheduler');
  });

  it('child 的 event 与调用点一致：静默丢弃，事件名只能由方法参数决定', () => {
    const { sink, log } = setup('development');
    log.child({ event: 'from_child' }).info('order_created');
    expect(sink.last().event).toBe('order_created');
  });
});

describe('级别与派生', () => {
  it('生产默认 info，debug 不输出；开发默认 debug', () => {
    expect(levelForEnv('production')).toBe('info');
    expect(levelForEnv('staging')).toBe('info');
    expect(levelForEnv('development')).toBe('debug');

    const prod = setup('production');
    prod.log.debug('noisy', { a: 1 });
    expect(prod.sink.lines).toHaveLength(0);

    const dev = setup('development');
    dev.log.debug('noisy', { a: 1 });
    expect(dev.sink.lines).toHaveLength(1);
  });

  it('child 继承父字段并可叠加模块名', () => {
    const { sink, log } = setup();
    const payment = log.child({ module: 'payment' });
    payment.warn('provider_slow', { duration_ms: 3000 });
    const row: LogRow = sink.last();
    expect(row.module).toBe('payment');
    expect(row.event).toBe('provider_slow');
    expect(row.service).toBe('waselect-server');
  });
});
