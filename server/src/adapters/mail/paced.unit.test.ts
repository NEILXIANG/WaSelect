/**
 * 职责：`createPacedMailer` 的排队与间隔（统一结论 5.2 / AJ-426）。
 * @why 用假时钟：断言"两次开始发送之间至少隔 N 毫秒"不能靠真 sleep（慢且抖）。
 */
import { describe, expect, it } from 'vitest';
import type { MailMessage, MailResult, Mailer } from '../../ports/mailer.js';
import { MAIL_MIN_INTERVAL_MS, createPacedMailer } from './paced.js';

const msg = (k: string): MailMessage => ({
  to: 'jane.doe@example.com',
  subject: 's',
  text: 't',
  idempotencyKey: k,
  tag: 'order.paid',
});

/** 假时钟：sleep 只把时间往前拨，不真等。 */
function fakeTime(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

/** 记录每次开始发送的时刻与同时在途的最大数。 */
function recorder(
  clock: { now: () => number },
  fail: (k: string) => boolean = () => false,
): { inner: Mailer; starts: number[]; order: string[]; maxInFlight: () => number } {
  const starts: number[] = [];
  const order: string[] = [];
  let inFlight = 0;
  let max = 0;
  return {
    starts,
    order,
    maxInFlight: () => max,
    inner: {
      send: async (m): Promise<MailResult> => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        starts.push(clock.now());
        order.push(m.idempotencyKey);
        await Promise.resolve();
        inFlight -= 1;
        if (fail(m.idempotencyKey)) throw new Error(`boom ${m.idempotencyKey}`);
        return { status: 'sent', id: m.idempotencyKey };
      },
    },
  };
}

describe('createPacedMailer', () => {
  it('🔴 同时交来 3 封：逐封发（同时在途最多 1 封）、按交来的顺序、相邻两次开始至少隔 MAIL_MIN_INTERVAL_MS', async () => {
    const clock = fakeTime();
    const r = recorder(clock);
    const m = createPacedMailer(r.inner, { minIntervalMs: MAIL_MIN_INTERVAL_MS, ...clock });
    const out = await Promise.all([m.send(msg('a')), m.send(msg('b')), m.send(msg('c'))]);
    expect(out.map((x) => (x.status === 'sent' ? x.id : x.reason))).toEqual(['a', 'b', 'c']);
    expect(r.order).toEqual(['a', 'b', 'c']);
    expect(r.maxInFlight()).toBe(1);
    expect(r.starts[1]! - r.starts[0]!).toBeGreaterThanOrEqual(MAIL_MIN_INTERVAL_MS);
    expect(r.starts[2]! - r.starts[1]!).toBeGreaterThanOrEqual(MAIL_MIN_INTERVAL_MS);
  });

  it('第一封不等；距上次已超过间隔的也不等（空闲时实时邮件不被拖慢）', async () => {
    const clock = fakeTime();
    const r = recorder(clock);
    const m = createPacedMailer(r.inner, { minIntervalMs: 200, ...clock });
    const t0 = clock.now();
    await m.send(msg('a'));
    expect(r.starts[0]).toBe(t0);
    await clock.sleep(1000);
    const t1 = clock.now();
    await m.send(msg('b'));
    expect(r.starts[1]).toBe(t1);
  });

  it('🔴 一封失败：错误原样抛给它自己的调用方，后面的照常发（不卡死队列）', async () => {
    const clock = fakeTime();
    const r = recorder(clock, (k) => k === 'a');
    const m = createPacedMailer(r.inner, { minIntervalMs: 200, ...clock });
    const [a, b] = await Promise.allSettled([m.send(msg('a')), m.send(msg('b'))]);
    expect(a.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason).toMatchObject({ message: 'boom a' });
    expect(b).toEqual({ status: 'fulfilled', value: { status: 'sent', id: 'b' } });
  });

  it('官方上限口径：间隔对应每秒不超过 5 封（Resend 每团队 10 次/秒的一半）', () => {
    expect(1000 / MAIL_MIN_INTERVAL_MS).toBe(5);
  });
});
