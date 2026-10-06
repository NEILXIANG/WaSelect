/** 职责：selectMailer 的选择分支（剩余清单 2-2）。 */
import { describe, expect, it } from 'vitest';
import { MemorySink } from '../../../../test/helpers/memory-sink.js';
import { createLogger } from '../../logger.js';
import type { HttpRequest } from '../../ports/http-client.js';
import { selectMailer } from './select.js';

const MSG = {
  to: 'a@example.com',
  subject: 's',
  text: 't',
  idempotencyKey: 'k',
  tag: 'order.paid',
};

describe('selectMailer', () => {
  it('有密钥 + 发件人 → 真的走 HTTP（Resend）', async () => {
    const calls: HttpRequest[] = [];
    const m = selectMailer(
      { MAIL_PROVIDER_API_KEY: 're_k', MAIL_FROM: 'f@example.com' },
      {
        http: {
          send: (r) => (calls.push(r), Promise.resolve({ status: 200, body: '{"id":"x"}' })),
        },
        logger: createLogger({ env: 'test', destination: new MemorySink() }),
      },
    );
    expect(await m.send(MSG)).toEqual({ status: 'sent', id: 'x' });
    expect(calls).toHaveLength(1);
  });

  it('没有密钥 → 只记日志，一次 HTTP 都不发', async () => {
    const calls: HttpRequest[] = [];
    const m = selectMailer(
      { MAIL_PROVIDER_API_KEY: undefined, MAIL_FROM: undefined },
      {
        http: { send: (r) => (calls.push(r), Promise.resolve({ status: 200, body: '{}' })) },
        logger: createLogger({ env: 'test', destination: new MemorySink() }),
      },
    );
    expect((await m.send(MSG)).status).toBe('skipped');
    expect(calls).toHaveLength(0);
  });
});
