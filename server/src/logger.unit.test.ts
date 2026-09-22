/**
 * 职责：运行日志（流 A）的 L0 单测（F5）。
 * 用内存 sink 捕获真实 pino 输出（不 mock 掉 pino——日志格式正是要验的东西）。
 * @see docs/代码注释规范与日志体系设计.md（统一字段）；docs/地基搭建清单.md F5
 */
import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger, levelForEnv, type Logger } from './logger.js';
import { currentContext, runWithContext } from './context.js';

/** 内存 sink：收集 pino 写出的每一行 JSON。 */
class MemorySink implements DestinationStream {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line.trim());
  }
  last(): Record<string, unknown> {
    const line = this.lines[this.lines.length - 1];
    if (line === undefined) throw new Error('还没有任何日志输出');
    return JSON.parse(line) as Record<string, unknown>;
  }
}

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
    const row = sink.last();
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
    const row = sink.last();
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
    const row = sink.last();
    expect(row.module).toBe('payment');
    expect(row.event).toBe('provider_slow');
    expect(row.service).toBe('waselect-server');
  });
});
