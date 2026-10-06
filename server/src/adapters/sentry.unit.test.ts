/**
 * 职责：Sentry 上报分流（剩余清单 2-3）——只转 error / fatal、envelope 形状、限流、上报失败不影响日志。
 * @see ./sentry.ts；../sentry-dsn.ts
 */
import { describe, expect, it } from 'vitest';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { parseSentryDsn } from '../sentry-dsn.js';
import { createSentryTee } from './sentry.js';

const DSN = parseSentryDsn('https://abc123@o1.ingest.sentry.io/42');
if (DSN === null) throw new Error('fixture DSN 解析失败');

function setup(opts: { fail?: boolean; maxPerMinute?: number } = {}) {
  const inner = new MemorySink();
  const sent: Array<{ url: string; body: string }> = [];
  let now = 1_000_000;
  const tee = createSentryTee(inner, {
    dsn: DSN as NonNullable<typeof DSN>,
    environment: 'production',
    maxPerMinute: opts.maxPerMinute ?? 30,
    nowMs: () => now,
    send: (url, body) => {
      sent.push({ url, body });
      return opts.fail === true ? Promise.reject(new Error('network')) : Promise.resolve();
    },
  });
  const logger = createLogger({ env: 'production', destination: tee });
  return { inner, sent, logger, tick: (ms: number) => (now += ms) };
}

const lines = (body: string) => body.split('\n').filter((l) => l !== '');

describe('createSentryTee', () => {
  it('🔴 error 级 → 一个 envelope：头带 dsn、item 类型 event、payload 带 level / message / environment', () => {
    const { sent, inner, logger } = setup();
    logger.error('order_mail_failed', {
      order_id: 'o-1',
      result: 'failed',
      ctx: { tag: 'order.shipped' },
    });
    expect(inner.lines).toHaveLength(1); // 原日志照常写
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://o1.ingest.sentry.io/api/42/envelope/');
    const [h, item, payload] = lines(sent[0]?.body ?? '').map(
      (l) => JSON.parse(l) as Record<string, unknown>,
    );
    expect(h?.['dsn']).toBe('https://abc123@o1.ingest.sentry.io/42');
    expect(h?.['event_id']).toMatch(/^[0-9a-f]{32}$/);
    expect(item?.['type']).toBe('event');
    expect(payload).toMatchObject({
      level: 'error',
      message: 'order_mail_failed',
      environment: 'production',
    });
    expect(payload?.['event_id']).toBe(h?.['event_id']);
    expect((payload?.['extra'] as Record<string, unknown>)['order_id']).toBe('o-1');
  });

  it('info / warn 不上报', () => {
    const { sent, logger } = setup();
    logger.info('x_ok', { result: 'ok' });
    logger.warn('x_warn', { result: 'warn' });
    expect(sent).toHaveLength(0);
  });

  it('🔴 上报的是**脱敏后**的行：邮箱、电话不出现在 envelope 里', () => {
    const { sent, logger } = setup();
    logger.error('x_failed', {
      result: 'failed',
      ctx: { email: 'jane.doe@example.com', phone: '+14155550123' },
    });
    expect(sent[0]?.body).not.toContain('jane.doe@example.com');
    expect(sent[0]?.body).not.toContain('4155550123');
  });

  it('每分钟上限：超出的不再上报（一次故障刷屏不把配额打光），下一分钟恢复', () => {
    const { sent, logger, tick } = setup({ maxPerMinute: 2 });
    for (let i = 0; i < 5; i += 1) logger.error('burst', { result: 'failed' });
    expect(sent).toHaveLength(2);
    tick(60_000);
    logger.error('burst', { result: 'failed' });
    expect(sent).toHaveLength(3);
  });

  it('上报失败 → 吞掉（不抛、不写日志，避免"上报失败 → error 日志 → 再上报"的环）', async () => {
    const { inner, logger } = setup({ fail: true });
    logger.error('x_failed', { result: 'failed' });
    await new Promise((r) => setTimeout(r, 10));
    expect(inner.lines).toHaveLength(1);
  });
});

describe('parseSentryDsn', () => {
  it('合法 DSN → envelope 地址；缺 key / 非数字项目 / 非 http(s) / 乱码 → null', () => {
    expect(parseSentryDsn('https://k@sentry.example.com/7')?.envelopeUrl).toBe(
      'https://sentry.example.com/api/7/envelope/',
    );
    expect(parseSentryDsn('https://sentry.example.com/7')).toBeNull();
    expect(parseSentryDsn('https://k@sentry.example.com/abc')).toBeNull();
    expect(parseSentryDsn('ftp://k@sentry.example.com/7')).toBeNull();
    expect(parseSentryDsn('not a url')).toBeNull();
  });
});
