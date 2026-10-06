/**
 * 职责：Resend 适配器单测（剩余清单 2-2）——请求形状、鉴权、幂等键、失败分支、日志不含收件人。
 * @see ./resend.ts
 */
import { describe, expect, it } from 'vitest';
import { MemorySink } from '../../../../test/helpers/memory-sink.js';
import { createLogger } from '../../logger.js';
import type { HttpClient, HttpRequest } from '../../ports/http-client.js';
import { RESEND_ENDPOINT, createResendMailer } from './resend.js';
import { createLogOnlyMailer } from './log-only.js';

const MSG = {
  to: 'jane.doe@example.com',
  subject: 'Your order WS2610060001 has shipped',
  text: 'Tracking: EM123456789JP',
  idempotencyKey: 'order.shipped:o-1',
  tag: 'order.shipped',
};

function http(status: number, body: string): { client: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    client: {
      send: (req) => {
        calls.push(req);
        return Promise.resolve({ status, body });
      },
    },
  };
}

describe('createResendMailer', () => {
  it('POST /emails：Bearer 鉴权、Idempotency-Key、JSON 体（from / to 数组 / subject / text）', async () => {
    const h = http(200, '{"id":"49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}');
    const m = createResendMailer({
      apiKey: 're_test_key',
      from: 'Waselect <shop@example.com>',
      http: h.client,
    });
    const r = await m.send(MSG);
    expect(r).toEqual({ status: 'sent', id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    const req = h.calls[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe(RESEND_ENDPOINT);
    expect(req?.headers?.['authorization']).toBe('Bearer re_test_key');
    expect(req?.headers?.['idempotency-key']).toBe('order.shipped:o-1');
    expect(req?.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(String(req?.body))).toEqual({
      from: 'Waselect <shop@example.com>',
      to: ['jane.doe@example.com'],
      subject: MSG.subject,
      text: MSG.text,
    });
  });

  it('非 2xx → 抛错；错误消息带状态码但**不带收件人**（错误会进日志）', async () => {
    const h = http(422, '{"name":"validation_error","message":"Invalid `to` field"}');
    const m = createResendMailer({ apiKey: 'k', from: 'f@example.com', http: h.client });
    const err: unknown = await m.send(MSG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('422');
    expect((err as Error).message).not.toContain('jane.doe');
  });

  it('2xx 但响应缺 id → 抛错（不把"不知道发没发"报成已发）', async () => {
    const m = createResendMailer({
      apiKey: 'k',
      from: 'f@example.com',
      http: http(200, '{}').client,
    });
    await expect(m.send(MSG)).rejects.toThrow('id');
  });

  it('幂等键超过 256 字符 → 发送前就拒（服务商上限，@measured 见实现）', async () => {
    const h = http(200, '{"id":"x"}');
    const m = createResendMailer({ apiKey: 'k', from: 'f@example.com', http: h.client });
    await expect(m.send({ ...MSG, idempotencyKey: 'k'.repeat(257) })).rejects.toThrow('256');
    expect(h.calls).toHaveLength(0);
  });
});

describe('createLogOnlyMailer', () => {
  it('未配服务商 → skipped，记一条 mail_skipped（带 tag，不带收件人）', async () => {
    const sink = new MemorySink();
    const m = createLogOnlyMailer(createLogger({ env: 'test', destination: sink }));
    expect(await m.send(MSG)).toEqual({ status: 'skipped', reason: 'no_provider' });
    const logs = sink.find('mail_skipped');
    expect(logs).toHaveLength(1);
    expect((logs[0]?.['ctx'] as { tag?: string }).tag).toBe('order.shipped');
    expect(JSON.stringify(sink.lines)).not.toContain('jane.doe');
  });
});
