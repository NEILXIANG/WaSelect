/**
 * 职责：回调统一管线的 L0 用例（F11）——覆盖**端到端到不了**的分支。
 *
 * @why 真库能覆盖 happy path 与宽限期，但覆盖不了三类：
 *      ① 非 `succeeded` 的归一化结果（真库里没有机构会给我们发"未知结果"）；
 *      ② 租约易主（`finish` 返回 false）与"交还租约"这两条栅栏分支；
 *      ③ 冲突分层的**判定顺序**（40400 与 40902 谁先判）。
 *      这三类恰好是"改错了也不会报错、只是钱会错"的那一类，必须用桩存储钉住。
 *
 * @why 用**桩 WebhookStore**而不是真库：这里要验的是"管线在各种登记结果下怎么走"，
 *      而真库的登记结果由并发与真实时间决定，编排不出来（N16 同一类理由）。
 *
 * @limitation 只验管线的**决策**，不验 SQL：真库的四态语义在 `adapters/webhooks.db.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createLogger } from '../logger.js';
import type { ProviderEvent } from '../ports/payment.js';
import type {
  ClaimResult,
  ClaimState,
  WebhookEventInput,
  WebhookStore,
} from '../ports/webhooks.js';
import { handleProviderCallback, type CallbackPipelineDeps } from './pay-callback.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';

/** 固定锚点：宽限期算术全部相对它，避免用例之间互相污染。 */
const FIRST = new Date('2026-01-02T00:00:00.000Z');

interface Recorder {
  store: WebhookStore;
  /** 被登记的事件（provider / eventId / eventType / hash）。 */
  claimed: WebhookEventInput[];
  finished: Array<{ result: string; token: string; note?: string | undefined }>;
  released: string[];
}

/**
 * 桩存储：`state` 决定本次登记结果，`elapsedMs` 决定"首次到达到现在"的时长，
 * `finishReturns` 决定是否让栅栏失败。
 */
function fakeStore(opts: {
  state?: ClaimState;
  elapsedMs?: number;
  finishReturns?: boolean;
}): Recorder {
  const claimed: WebhookEventInput[] = [];
  const finished: Recorder['finished'] = [];
  const released: string[] = [];
  const state = opts.state ?? 'new';
  const token = state === 'new' || state === 'retry' ? 'tok-1' : undefined;
  const store: WebhookStore = {
    async claim(input) {
      claimed.push(input);
      const result: ClaimResult = {
        state,
        firstReceivedAt: FIRST,
        nowAt: new Date(FIRST.getTime() + (opts.elapsedMs ?? 0)),
        ...(token !== undefined ? { token } : {}),
      };
      return result;
    },
    async finish(input) {
      finished.push({ result: input.result, token: input.token, note: input.note });
      return opts.finishReturns ?? true;
    },
    async releaseLease(input) {
      released.push(input.token);
      return true;
    },
  };
  return { store, claimed, finished, released };
}

function deps(
  rec: Recorder,
  apply: (e: ProviderEvent) => Promise<void>,
  graceMs = 900_000,
): { d: CallbackPipelineDeps; sink: MemorySink } {
  const sink = new MemorySink();
  return {
    d: {
      webhooks: rec.store,
      logger: createLogger({ env: 'test', destination: sink }),
      graceMs,
      apply,
    },
    sink,
  };
}

function event(over: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    eventId: 'evt-1',
    rawType: 'checkout.session.completed',
    outcome: 'succeeded',
    orderId: 'sk-1',
    providerRef: 'cs_1',
    ...over,
  };
}

const RAW = Buffer.from('{"hello":"world"}');

describe('handleProviderCallback：登记与去重', () => {
  it('首次到达 → 落账 + 封口 paid，并返回 disposition=paid', async () => {
    const rec = fakeStore({});
    const { d } = deps(rec, async () => undefined);
    const out = await handleProviderCallback(d, 'stripe', RAW, event());
    expect(out).toEqual({
      disposition: 'paid',
      status: 200,
      body: { received: true, order_id: 'sk-1' },
    });
    expect(rec.finished).toEqual([{ result: 'paid', token: 'tok-1', note: undefined }]);
    // 登记的 provider 就是通道名：对账时"这条回调是谁发的"必须能直接回答
    expect(rec.claimed[0]?.provider).toBe('stripe');
    expect(rec.claimed[0]?.eventType).toBe('checkout.session.completed');
  });

  it('重复投递（handled）→ 2xx + duplicate，**apply 根本不执行**', async () => {
    const rec = fakeStore({ state: 'handled' });
    let called = 0;
    const { d, sink } = deps(rec, async () => {
      called += 1;
    });
    const out = await handleProviderCallback(d, 'stripe', RAW, event());
    expect(out.disposition).toBe('duplicate');
    expect(out.body).toEqual({ received: true, order_id: 'sk-1', duplicate: true });
    expect(called).toBe(0);
    expect(rec.finished).toHaveLength(0);
    expect(sink.find('webhook_duplicate')).toHaveLength(1);
  });

  it('别人在处理（inflight）→ 503 + Retry-After 10，不处理也不封口', async () => {
    const rec = fakeStore({ state: 'inflight' });
    const { d, sink } = deps(rec, async () => undefined);
    const out = await handleProviderCallback(d, 'stripe', RAW, event());
    expect(out.status).toBe(503);
    expect(out.retryAfter).toBe(10);
    expect(out.body).toEqual({ received: false, reason: 'already_processing' });
    expect(rec.finished).toHaveLength(0);
    expect(sink.find('webhook_inflight')).toHaveLength(1);
  });
});

describe('handleProviderCallback：非 succeeded 的结果不落账（@limitation 一）', () => {
  it('expired / failed / unknown 一律 2xx 收下 + 登记 ignored:<outcome>，apply 不执行', async () => {
    for (const outcome of ['expired', 'failed', 'disputed', 'unknown'] as const) {
      const rec = fakeStore({});
      let called = 0;
      const { d, sink } = deps(rec, async () => {
        called += 1;
      });
      const out = await handleProviderCallback(
        d,
        'stripe',
        RAW,
        event({ outcome, rawType: `x.${outcome}` }),
      );
      expect(out.disposition).toBe('ignored');
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ received: true, order_id: 'sk-1', ignored: outcome });
      expect(called).toBe(0);
      expect(rec.finished[0]?.result).toBe(`ignored:${outcome}`);
      // 不落业务状态也必须**留下痕迹**：否则"机构发了而我们没反应"无从查起
      expect(sink.find('callback_outcome_ignored')).toHaveLength(1);
    }
  });

  it('重复投递的**非成功**事件同样走去重（机构会重发过期通知）', async () => {
    const rec = fakeStore({ state: 'handled' });
    const { d } = deps(rec, async () => undefined);
    const out = await handleProviderCallback(d, 'stripe', RAW, event({ outcome: 'expired' }));
    expect(out.disposition).toBe('duplicate');
    expect(rec.finished).toHaveLength(0);
  });
});

describe('handleProviderCallback：冲突分层（宽限期用 DB 时钟）', () => {
  it('订单不存在 + 宽限期内 → 503 + **交还租约**，且不封口', async () => {
    const rec = fakeStore({ elapsedMs: 1_000 });
    const { d, sink } = deps(rec, async () => {
      throw new AppError(40400, { order_id: 'sk-1' });
    });
    const out = await handleProviderCallback(d, 'stripe', RAW, event());
    expect(out.disposition).toBe('early');
    expect(out.status).toBe(503);
    expect(out.retryAfter).toBe(30);
    // ⚠️ 交还租约是这条分支的关键：不交还的话机构按 Retry-After 的重投会被判成 inflight
    expect(rec.released).toEqual(['tok-1']);
    // processed_at 保持 NULL（不封口）才是对账信号
    expect(rec.finished).toHaveLength(0);
    expect(sink.find('callback_early')[0]?.level).toBe('warn');
  });

  it('订单不存在 + 超过宽限期 → 2xx + error 告警 + 落 unmatched', async () => {
    const rec = fakeStore({ elapsedMs: 1_000, state: 'retry' });
    const { d, sink } = deps(
      rec,
      async () => {
        throw new AppError(40400, { order_id: 'sk-1' });
      },
      500,
    );
    const out = await handleProviderCallback(d, 'stripe', RAW, event());
    expect(out.disposition).toBe('unmatched');
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ received: true, order_id: 'sk-1', ignored: 'unmatched' });
    expect(rec.finished[0]?.result).toBe('unmatched:order_not_found');
    expect(sink.find('callback_unmatched')[0]?.level).toBe('error');
  });

  it('宽限期 = 0 是**零宽限**：elapsed 恰为 0 也要转 unmatched（不能写成 <=）', async () => {
    const rec = fakeStore({ elapsedMs: 0 });
    const { d } = deps(
      rec,
      async () => {
        throw new AppError(40400, { order_id: 'sk-1' });
      },
      0,
    );
    const out = await handleProviderCallback(d, 'stripe', RAW, event());
    expect(out.disposition).toBe('unmatched');
  });

  it('已是 paid → paid:already + **info**（不是告警：N13 正常形态）', async () => {
    const rec = fakeStore({});
    const { d, sink } = deps(rec, async () => {
      throw new AppError(40902, { from: 'paid', to: 'paid' });
    });
    const out = await handleProviderCallback(d, 'stripe', RAW, event());
    expect(out.disposition).toBe('paid:already');
    expect(rec.finished[0]?.result).toBe('paid:already');
    expect(sink.find('paid_already')[0]?.level).toBe('info');
    expect(sink.find('callback_conflict')).toHaveLength(0);
  });

  it('其它状态冲突（如 expired）→ 2xx + warn（重发也不会变，靠对账）', async () => {
    const rec = fakeStore({});
    const { d, sink } = deps(rec, async () => {
      throw new AppError(40902, { from: 'expired', to: 'paid' });
    });
    const out = await handleProviderCallback(d, 'stripe', RAW, event());
    expect(out.disposition).toBe('status_conflict');
    expect(rec.finished[0]?.result).toBe('ignored:status_conflict');
    expect(sink.find('callback_conflict')[0]?.level).toBe('warn');
  });

  it('非 40400/40902 的异常**原样抛出**（业务 bug 必须变 5xx 让机构重发）', async () => {
    const rec = fakeStore({});
    const { d } = deps(rec, async () => {
      throw new AppError(50003, { reason: '汇率不可用' });
    });
    await expect(handleProviderCallback(d, 'stripe', RAW, event())).rejects.toMatchObject({
      code: 50003,
    });
    // 不封口 → 这行停在 processed_at IS NULL，由 F13 对账捞起（@limitation 三）
    expect(rec.finished).toHaveLength(0);
  });
});

describe('handleProviderCallback：栅栏（N22）', () => {
  it('finish 返回 false（租约易主）→ 仍按成功应答，但记一条 warn', async () => {
    const rec = fakeStore({ finishReturns: false });
    const { d, sink } = deps(rec, async () => undefined);
    const out = await handleProviderCallback(d, 'stripe', RAW, event());
    expect(out.disposition).toBe('paid');
    expect(out.status).toBe(200);
    expect(sink.find('webhook_result_not_written')).toHaveLength(1);
  });

  it('登记用的是**原始字节**的摘要，与事件内容无关（改一个字节就是另一个事件）', async () => {
    const rec = fakeStore({});
    const { d } = deps(rec, async () => undefined);
    await handleProviderCallback(d, 'stripe', RAW, event());
    const h1 = rec.claimed[0]?.hash;
    const rec2 = fakeStore({});
    const { d: d2 } = deps(rec2, async () => undefined);
    await handleProviderCallback(d2, 'stripe', Buffer.from('{"hello":"world" }'), event());
    expect(rec2.claimed[0]?.hash).not.toBe(h1);
  });
});
