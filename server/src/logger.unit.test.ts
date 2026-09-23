/**
 * 职责：运行日志（流 A）的 L0 单测（F5）。
 * 用内存 sink 捕获真实 pino 输出（不 mock 掉 pino——日志格式正是要验的东西）。
 * @see docs/代码注释规范与日志体系设计.md（统一字段）；docs/地基搭建清单.md F5
 */
import { describe, expect, it } from 'vitest';
import { createLogger, levelForEnv, type Logger } from './logger.js';
import { currentContext, runWithContext } from './context.js';
import { MemorySink, type LogRow } from '../../test/helpers/memory-sink.js';

function setup(env: 'development' | 'production' = 'development'): {
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
  it('调用点字段 > 请求上下文 > child 绑定，event 恒为最优先', () => {
    const { sink, log } = setup();
    const child = log.child({ module: 'payment', channel: 'mock' });
    runWithContext({ channel: 'wechat', module: 'ctx-module' }, () => {
      child.info('pay_started', { channel: 'stripe' });
    });
    const row = sink.last();
    expect(row.channel).toBe('stripe');
    expect(row.module).toBe('ctx-module');
    expect(row.event).toBe('pay_started');
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
