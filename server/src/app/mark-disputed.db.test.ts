/**
 * 职责：`app/mark-disputed.ts` 的真库用例（I2 U-F3）——拒付落库。
 *
 * @why 必须真库：这个函数的正确性**全在副作用与并发语义上**——
 *      行锁顺序、幂等（重放不改东西）、"不把 won/lost 改回 open"、
 *      开案时刻到底写的是哪个时间。桩存储能验"调用了几条 SQL"，
 *      验不了"两条并发事务谁等谁"与"to_timestamp 转出来是什么"。
 *
 * @why 开案时刻断言的是**机构给的时间**，不是"入库那一刻"：
 *      两个值差 115 天（样本工厂刻意造的），写错也不报错——
 *      表现是举证期限被算短，那是真金白银（AJ-159 / 迁移 013）。
 *
 * @why 落库结果用 `createRiskAdminRepo().listDisputes()` **换一个读取方**再读一遍：
 *      断言"我自己写进去的列"是自证（§2 第 21 条）。真正的消费者是风控列表，
 *      它由 `dispute_id is not null` 决定"这一行算不算拒付"——
 *      只有它读得到，才证明"落库之后运营真的能在后台看见这条"。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createRiskAdminRepo } from '../adapters/risk-admin.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { AppError } from '../errors.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import type { ProviderEvent } from '../ports/payment.js';
import { createWebhookStore } from '../adapters/webhooks.js';
import { handleProviderCallback, type CallbackPipelineDeps } from './pay-callback.js';
import { RESULT_DISPUTED, RESULT_DISPUTE_CLOSED } from './webhook-results.js';
import { parseDisputeResult } from '../domain/dispute-input.js';
import { shipGuard, refundGuard } from '../domain/admin-order-actions.js';
import { markDisputeClosed, markOrderDisputed } from './mark-disputed.js';

/** 事件总线需要一个 logger；这里不关心它输出什么（另有专门的分发顺序测试）。 */
const SILENT = createLogger({ env: 'test', destination: new MemorySink() });

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1')`;
});

/** 造一单已付款 + 一笔 succeeded 支付行（拒付落库的前置事实）。 */
async function seedPaid(
  orderId: string,
  opts: { provider?: string; amount?: number; currency?: string } = {},
): Promise<void> {
  const provider = opts.provider ?? 'stripe';
  const amount = opts.amount ?? 1000;
  const currency = opts.currency ?? 'USD';
  await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                               total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
           values (${orderId}, ${`W-${orderId}`}, 'u-1', 'paid', ${amount}, 0, 0, ${amount}, 500,
                   '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
  await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
           values (${`p-${orderId}`}, ${orderId}, ${provider}, 'succeeded', ${currency}, ${amount})`;
}

/**
 * 机构报的开案时刻（unix 毫秒）。
 * 刻意取一个**远早于现在**的时间：与"入库时刻"可以相差数月，
 * 写错也不会报错，只能靠断言钉住（AJ-159）。
 */
const OPENED_MS = 1_690_000_000_000;
/** 同一个时刻的 ISO 字符串（写死而不是 `new Date(ms)` 转：测试文件同样受 F10 约束）。 */
const OPENED_ISO = '2023-07-22T04:26:40.000Z';

function dispute(over: Partial<Parameters<typeof markOrderDisputed>[4]> = {}) {
  return {
    channel: 'stripe',
    disputeId: 'dp_1',
    amountMinor: 1000,
    currency: 'USD',
    openedAtMs: OPENED_MS,
    ...over,
  };
}

/** 读回 payments 那四列（拒付账的唯一形状）。 */
async function paymentRow(orderId: string): Promise<Record<string, unknown>> {
  const rows = await db`
    select dispute_id, dispute_status, dispute_amount, dispute_opened_at, dispute_closed_at
      from payments where order_id = ${orderId}`;
  return (rows[0] ?? {}) as Record<string, unknown>;
}

async function orderRow(orderId: string): Promise<Record<string, unknown>> {
  const rows = await db`select status, has_dispute from orders where id = ${orderId}`;
  return (rows[0] ?? {}) as Record<string, unknown>;
}

async function events(orderId: string): Promise<string[]> {
  const rows =
    await db`select status, actor from order_events where order_id = ${orderId} order by id`;
  // 拒付事件由机构回调写入：actor 必须是 `provider:<channel>`（一致性审计 C3，AJ-176）
  for (const r of rows) expect(String(r.actor)).toMatch(/^provider:[a-z]+$/);
  return rows.map((r) => String(r.status));
}

describe('markOrderDisputed：happy path', () => {
  it('落四列 + orders.has_dispute + 一条 dispute_opened 事件', async () => {
    await seedPaid('o-1');
    await markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute());

    const p = await paymentRow('o-1');
    expect(p['dispute_id']).toBe('dp_1');
    expect(p['dispute_status']).toBe('open');
    expect(Number(p['dispute_amount'])).toBe(1000);

    // 🔴 开案时刻必须是**机构报的时间**，不是入库那一刻（举证期限的起点）
    const at = p['dispute_opened_at'] as Date;
    expect(at.getTime()).toBe(OPENED_MS);
    // 与"现在"差得远，才说明这不是 now()（差 115 天量级）
    expect(Math.abs(Date.now() - at.getTime())).toBeGreaterThan(30 * 24 * 3600 * 1000);

    expect((await orderRow('o-1'))['has_dispute']).toBe(true);
    expect(await events('o-1')).toEqual(['dispute_opened']);
  });

  it('🔴 不迁移订单状态：货态仍是 paid（has_dispute 是与货态正交的资金标记）', async () => {
    await seedPaid('o-1');
    await markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute());
    expect((await orderRow('o-1'))['status']).toBe('paid');
  });

  it('换一个读取方：风控列表能看见这条拒付（§2 第 21 条，不自证）', async () => {
    await seedPaid('o-1');
    await markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute());
    const rows = await createRiskAdminRepo(db).listDisputes();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.disputeId).toBe('dp_1');
    expect(rows[0]?.disputeStatus).toBe('open');
    expect(rows[0]?.disputeAmount).toBe(1000);
    // 开案时刻在风控侧也是机构报的那个（同一个字段，不是另算的）
    expect(rows[0]?.openedAt?.getTime()).toBe(OPENED_MS);
  });

  it('事件的 at 与 dispute_opened_at **同源**（都是开案时刻，不是入库时刻）', async () => {
    /**
     * @why 这一条是缺陷注入补出来的：初版只断言"事件名对不对"，
     *      把 `at: openedAt.toISOString()` 注成 `at: new Date().toISOString()`
     *      **一条都没红**——事件的时刻错了却完全没有守护。
     *      而 `at` 正是订阅者（将来的通知、埋点）唯一的时刻来源，
     *      它与库里那列不一致，就等于"同一件事有两个发生时间"。
     */
    await seedPaid('o-1');
    const bus = createEventBus(SILENT);
    const ats: string[] = [];
    bus.subscribe('order.dispute_opened', (e) => {
      ats.push(e.at);
    });
    await markOrderDisputed(db, bus, SILENT, 'o-1', dispute());
    expect(ats).toEqual([OPENED_ISO]);
  });
});

describe('markOrderDisputed：幂等（机构会重发 charge.dispute.created）', () => {
  it('同一 dispute_id 重放 → 不重复写事件、不刷新 opened_at', async () => {
    await seedPaid('o-1');
    await markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute());
    const first = await paymentRow('o-1');

    await markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute());
    const second = await paymentRow('o-1');

    expect(second['dispute_opened_at']).toEqual(first['dispute_opened_at']);
    // 事件不重复：否则"这条拒付开了几次案"在审计里答不出来
    expect(await events('o-1')).toEqual(['dispute_opened']);
  });

  it('🔴 重放**不得**把已结案的状态改回 open（won 的拒付重放后仍是 won）', async () => {
    /**
     * @why 这是 U-F3 审查草稿时抓出来的缺陷：payments 的 update 若不在幂等保护内，
     *      一条**旧的** `charge.dispute.created` 重投会把已经 won/lost 的拒付打回 open——
     *      后台因此显示"有进行中的拒付"，退款闸门被重新锁上，
     *      而实际上机构那边早就结案了。这种错误没有任何一方报错。
     */
    await seedPaid('o-1');
    await markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute());
    await db`update payments set dispute_status = 'won' where order_id = 'o-1'`;

    await markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute());
    expect((await paymentRow('o-1'))['dispute_status']).toBe('won');
  });

  it('不同的 dispute_id 到达 → 40902 dispute_id_conflict（不静默覆盖）', async () => {
    await seedPaid('o-1');
    await markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute());
    await expect(
      markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute({ disputeId: 'dp_2' })),
    ).rejects.toMatchObject({ code: 40902 });
    // 原拒付不被覆盖
    expect((await paymentRow('o-1'))['dispute_id']).toBe('dp_1');
  });
});

describe('markOrderDisputed：接线（经回调管线，不是只测函数）', () => {
  /**
   * @why 这一组刻意**绕开 HTTP**：它要验的是"管线的 disputed 落点真的接到本函数"，
   *      以及"落不上库时管线把它分到哪一层"。前者防"注册了却没接"（能力存在 ≠ 能力被用上），
   *      后者防"拒付静默丢失"——那是 U-F3 审查草稿时发现的最大缺陷。
   */
  function pipeline(): { sink: MemorySink; deps: CallbackPipelineDeps } {
    const sink = new MemorySink();
    return {
      sink,
      deps: {
        webhooks: createWebhookStore(db),
        logger: createLogger({ env: 'test', destination: sink }),
        graceMs: 900_000,
        appliers: {
          disputed: {
            apply: async (e: ProviderEvent, channel: string) =>
              markOrderDisputed(db, createEventBus(SILENT), SILENT, e.orderId, {
                channel,
                disputeId: e.providerRef,
                amountMinor: e.amountMinor,
                currency: e.currency,
                openedAtMs: e.occurredAtMs,
              }),
            result: RESULT_DISPUTED,
            disposition: 'disputed' as const,
          },
          /**
           * 结案落点：**与 mount.ts 同一条写法**（`parseDisputeResult` → 认不出就抛
           * `dispute_result_unknown`）。
           * @why 复制这段而不是另造一个"更方便"的 applier：这里要验的正是
           *      "domain 的映射 + 落库"这条链接起来是什么行为。用不同的写法就等于
           *      测了另一个东西（§2 第 21 条）。
           */
          dispute_closed: {
            apply: async (e: ProviderEvent, channel: string) => {
              const result = parseDisputeResult(e.disputeStatus);
              if (result === undefined) {
                throw new AppError(40902, {
                  reason: 'dispute_result_unknown',
                  ctx: { got: e.disputeStatus ?? null },
                });
              }
              return markDisputeClosed(db, createEventBus(SILENT), e.orderId, {
                channel,
                disputeId: e.providerRef,
                result,
              });
            },
            result: RESULT_DISPUTE_CLOSED,
            disposition: 'dispute_closed' as const,
          },
        },
      },
    };
  }

  function disputeEvent(over: Partial<ProviderEvent> = {}): ProviderEvent {
    return {
      eventId: 'evt-dp-1',
      rawType: 'charge.dispute.created',
      outcome: 'disputed',
      orderId: 'o-1',
      providerRef: 'dp_1',
      amountMinor: 1000,
      currency: 'USD',
      occurredAtMs: OPENED_MS,
      ...over,
    };
  }

  /** 结案事件（`charge.dispute.closed`）。`disputeStatus` 是机构的原始状态词。 */
  function closeEvent(over: Partial<ProviderEvent> & { disputeStatus?: string }): ProviderEvent {
    return {
      eventId: 'evt-dp-close',
      rawType: 'charge.dispute.closed',
      outcome: 'dispute_closed',
      orderId: 'o-1',
      providerRef: 'dp_1',
      ...over,
    } as ProviderEvent;
  }

  it('disputed 事件经管线 → 落库，登记行写 `disputed`（对账能精确检索拒付）', async () => {
    await seedPaid('o-1');
    const { deps } = pipeline();
    const out = await handleProviderCallback(
      deps,
      'stripe',
      Buffer.from('{"dispute":1}'),
      disputeEvent(),
    );
    expect(out.disposition).toBe('disputed');
    expect(out.status).toBe(200);
    expect((await paymentRow('o-1'))['dispute_id']).toBe('dp_1');

    const rows = await db`select result from webhook_events where event_id = 'evt-dp-1'`;
    // 🔴 不是 `ignored:disputed`：后者与"收下了但没反应"长得一样，对账扫不到拒付
    expect(rows[0]?.result).toBe('disputed');
  });

  it('🔴 机构没给开案时刻 → 2xx 不重发，但 **error 级** + `mismatch:dispute_unverifiable`（不静默）', async () => {
    /**
     * @why 这条是 U-F3 最重要的守护。`dispute_unverifiable` 若不在管线的
     *      MISMATCH_REASONS 里，它会落到"其它状态冲突"那条分支——**warn 级 + 2xx**。
     *      2xx 意味着机构不再重发，于是"拒付没落库"既不重试也不告警，
     *      举证窗口白白流失，且日志里只有一条会被日常噪音淹掉的 warn。
     *      必须 error 级 + 单独 result，让对账能精确检索这一类。
     */
    await seedPaid('o-1');
    const { deps, sink } = pipeline();
    const out = await handleProviderCallback(
      deps,
      'stripe',
      Buffer.from('{"dispute":2}'),
      disputeEvent({ eventId: 'evt-dp-2', occurredAtMs: undefined }),
    );
    expect(out.status).toBe(200); // 机构不必重发：重发也一样缺字段
    // 什么都没落
    expect((await paymentRow('o-1'))['dispute_id']).toBeNull();

    const line = sink.find('callback_settlement_mismatch');
    expect(line).toHaveLength(1);
    expect(line[0]?.level).toBe('error');
    // 不能退化成普通 status_conflict（那条是 warn，会被淹）
    expect(sink.find('callback_conflict')).toHaveLength(0);

    const rows = await db`select result from webhook_events where event_id = 'evt-dp-2'`;
    expect(rows[0]?.result).toBe('mismatch:dispute_unverifiable');
  });

  /**
   * B1 / AJ-193 的**接线级**守护：查询函（inquiry）关闭这条路径，从"机构事件"一路走到"闸门解锁"。
   *
   * @why 单测只证明了 `parseDisputeResult('warning_closed') === 'withdrawn'`，
   *      没证明 `markDisputeClosed` 接得住它、也没证明管线把它当成功而不是 mismatch。
   *      这条补的就是那一半：走真实管线，断言登记行写的是 `dispute_closed`（不是 mismatch）。
   */
  it('🔴 查询函关闭（warning_closed）经管线 → withdrawn 落库 + has_dispute 复位（B1 接线）', async () => {
    await seedPaid('o-1');
    const { deps } = pipeline();
    // 先开案（查询函以 warning_needs_response 开案，照样置 has_dispute=true）
    await handleProviderCallback(
      deps,
      'stripe',
      Buffer.from('{"d":1}'),
      disputeEvent({ eventId: 'evt-open' }),
    );
    expect((await orderRow('o-1'))['has_dispute']).toBe(true);

    const out = await handleProviderCallback(
      deps,
      'stripe',
      Buffer.from('{"d":2}'),
      closeEvent({ eventId: 'evt-close', disputeStatus: 'warning_closed' }),
    );
    expect(out.disposition).toBe('dispute_closed');
    expect(out.status).toBe(200);
    expect((await paymentRow('o-1'))['dispute_status']).toBe('withdrawn');
    expect((await orderRow('o-1'))['has_dispute']).toBe(false);
    // 🔴 不是 mismatch：结案被**接受**了（旧实现在这里抛 dispute_result_unknown）
    const rows = await db`select result from webhook_events where event_id = 'evt-close'`;
    expect(rows[0]?.result).toBe('dispute_closed');
    // 换一个读取方：闸门真的开了
    expect(shipGuard('paid', false).ok).toBe(true);
  });

  /**
   * 认不出的结案状态。
   * @why **全仓此前没有任何用例走到这个分支**（报告 B1 明确指出）：
   *      它是一条"抛错"的路，写错了的表现是"永远不被执行"，而那看起来一切正常。
   *      它必须 error 级 + 单独 result，否则"拒付结案没落库"既不重试也不告警。
   */
  it('🔴 认不出的结案状态 → error 级 + `mismatch:dispute_result_unknown`（不静默、不猜）', async () => {
    await seedPaid('o-1');
    const { deps, sink } = pipeline();
    await handleProviderCallback(
      deps,
      'stripe',
      Buffer.from('{"d":1}'),
      disputeEvent({ eventId: 'evt-open' }),
    );

    const out = await handleProviderCallback(
      deps,
      'stripe',
      Buffer.from('{"d":3}'),
      closeEvent({ eventId: 'evt-unknown', disputeStatus: 'under_review' }),
    );
    expect(out.status).toBe(200); // 机构不必重发：重发也一样认不出
    // 什么都没改（既不结案、也不解锁）
    expect((await paymentRow('o-1'))['dispute_status']).toBe('open');
    expect((await orderRow('o-1'))['has_dispute']).toBe(true);

    const line = sink.find('callback_settlement_mismatch');
    expect(line).toHaveLength(1);
    expect(line[0]?.level).toBe('error');
    const rows = await db`select result from webhook_events where event_id = 'evt-unknown'`;
    expect(rows[0]?.result).toBe('mismatch:dispute_result_unknown');
  });
});

describe('markDisputeClosed：结案（U-F4）', () => {
  /** 造一单**已有进行中拒付**的状态（结案的前置事实）。 */
  async function seedDisputed(orderId: string, status = 'open'): Promise<void> {
    await seedPaid(orderId);
    await db`update payments set dispute_id = 'dp_1', dispute_status = ${status},
                                 dispute_amount = 1000, dispute_opened_at = to_timestamp(${OPENED_MS / 1000})
             where order_id = ${orderId}`;
    await db`update orders set has_dispute = true where id = ${orderId}`;
  }

  it('won → 状态写 won + 结案时刻 + **has_dispute 复位 false**（闸门解锁）', async () => {
    /**
     * @why `has_dispute` 复位是这一条的核心：发货/退款闸门读的就是它，
     *      语义是"**进行中**的拒付"。结案后不复位 = 这张单永远不能发货、不能退款，
     *      而没有任何一方报错（运营只会觉得"系统不让我操作"）。
     */
    await seedDisputed('o-1');
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'won',
    });
    const p = await paymentRow('o-1');
    expect(p['dispute_status']).toBe('won');
    expect(p['dispute_closed_at']).toBeInstanceOf(Date);
    expect((await orderRow('o-1'))['has_dispute']).toBe(false);
    expect(await events('o-1')).toEqual(['dispute_closed']);
  });

  it('lost → **不复位**（钱已被拉回：再发货钱货两空、再退款 Stripe 必拒 charge_disputed；AJ-176 部分推翻 AJ-162 ③）', async () => {
    await seedDisputed('o-1');
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'lost',
    });
    expect((await paymentRow('o-1'))['dispute_status']).toBe('lost');
    expect((await orderRow('o-1'))['has_dispute']).toBe(true);
    expect(await events('o-1')).toEqual(['dispute_closed']);
  });

  it('开案时刻**不被**结案改动（举证期限的起点要保持可查）', async () => {
    await seedDisputed('o-1');
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'won',
    });
    const opened = (await paymentRow('o-1'))['dispute_opened_at'] as Date | null;
    expect(opened?.getTime()).toBe(OPENED_MS);
  });

  it('同一结果重投 → 幂等，不改结案时刻、不重复事件', async () => {
    await seedDisputed('o-1');
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'won',
    });
    const first = (await paymentRow('o-1'))['dispute_closed_at'];
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'won',
    });
    expect((await paymentRow('o-1'))['dispute_closed_at']).toEqual(first);
    expect(await events('o-1')).toEqual(['dispute_closed']);
  });

  it('🔴 结果不同 → 40902 dispute_result_conflict（不静默改判）', async () => {
    /**
     * @why "赢了又改成输了"影响财务口径（这笔钱算不算损失），
     *      必须留给人工裁决，不能让最后到达的那条事件说了算。
     */
    await seedDisputed('o-1');
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'won',
    });
    await expect(
      markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
        channel: 'stripe',
        disputeId: 'dp_1',
        result: 'lost',
      }),
    ).rejects.toMatchObject({ code: 40902 });
    expect((await paymentRow('o-1'))['dispute_status']).toBe('won');
  });

  it('没有这条拒付（开案没到 / 单号不符）→ 40902 dispute_not_open，不结错对象', async () => {
    await seedPaid('o-1'); // 有支付行，但没开过案
    await expect(
      markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
        channel: 'stripe',
        disputeId: 'dp_1',
        result: 'won',
      }),
    ).rejects.toMatchObject({ code: 40902 });
  });

  it('通道不符 → 40902 channel_mismatch', async () => {
    await seedDisputed('o-1');
    await expect(
      markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
        channel: 'wechat',
        disputeId: 'dp_1',
        result: 'won',
      }),
    ).rejects.toMatchObject({ code: 40902 });
  });

  /**
   * B1 / AJ-193：查询函（inquiry）关闭后的出口。
   *
   * @why 这条守的是"订单还有没有活路"：查询函以 `warning_needs_response` 开案照样置
   *      `has_dispute=true`，而旧实现在 `warning_closed` 这条路上抛 `dispute_result_unknown`
   *      ——于是 `has_dispute` 永远是 true，40909 / 40907 永久生效，全仓又只有
   *      本函数会写回 false。它**不是**显示问题：运营真的发不了货、退不了款。
   * @why 断言用 `shipGuard` **换一个读取方**（§2 第 21 条）：只断言布尔列等于 false
   *      是在自证"我写进去的值"；真正要证明的是"闸门真的开了"，那就调闸门本身。
   */
  it('🔴 withdrawn（查询函关闭）→ 解除限制：has_dispute 复位、闸门真的开了（B1）', async () => {
    await seedDisputed('o-1');
    // 开案后确实是锁着的（先证明"锁"这件事真的发生了，再看它有没有解开）
    expect((await orderRow('o-1'))['has_dispute']).toBe(true);
    expect(shipGuard('paid', true).ok).toBe(false);

    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'withdrawn',
    });
    expect((await paymentRow('o-1'))['dispute_status']).toBe('withdrawn');
    expect((await orderRow('o-1'))['has_dispute']).toBe(false);
    // 换一个读取方：发货闸门与退款闸门都必须放行
    expect(shipGuard('paid', Boolean((await orderRow('o-1'))['has_dispute'])).ok).toBe(true);
    expect(refundGuard('paid', Boolean((await orderRow('o-1'))['has_dispute'])).ok).toBe(true);
    expect(await events('o-1')).toEqual(['dispute_closed']);
  });

  // @why 与 withdrawn 的对照：lost 是**唯一**保持限制的结案结果（AJ-176）。
  //      两条一起跑才能证明"复位规则不是一律复位"，否则把实现改成都复位也照样绿。
  it('对照：lost 仍然保持限制（has_dispute 不复位，AJ-176）', async () => {
    await seedDisputed('o-1');
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'lost',
    });
    expect((await orderRow('o-1'))['has_dispute']).toBe(true);
    expect(shipGuard('paid', true).ok).toBe(false);
  });

  // @why withdrawn → won/lost 按冲突处理：同一 dispute_id 先被撤回、再判出输赢，
  //      在机构侧意味着另一条拒付；这里让它响亮失败，比悄悄改写财务口径安全。
  it('withdrawn 之后再收到 lost → 40902 dispute_result_conflict（不静默改判）', async () => {
    await seedDisputed('o-1');
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'withdrawn',
    });
    await expect(
      markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
        channel: 'stripe',
        disputeId: 'dp_1',
        result: 'lost',
      }),
    ).rejects.toMatchObject({ code: 40902 });
    expect((await paymentRow('o-1'))['dispute_status']).toBe('withdrawn');
    expect((await orderRow('o-1'))['has_dispute']).toBe(false);
  });

  it('换一个读取方：风控列表能按 withdrawn 筛出来（§2 第 21 条）', async () => {
    await seedDisputed('o-1');
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'withdrawn',
    });
    const rows = await createRiskAdminRepo(db).listDisputes('withdrawn');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.disputeStatus).toBe('withdrawn');
    expect(await createRiskAdminRepo(db).listDisputes('open')).toHaveLength(0);
  });

  it('订单不存在 → 40400', async () => {
    await expect(
      markDisputeClosed(db, createEventBus(SILENT), 'nope', {
        channel: 'stripe',
        disputeId: 'dp_1',
        result: 'won',
      }),
    ).rejects.toMatchObject({ code: 40400 });
  });

  it('换一个读取方：风控列表的状态变成 won（§2 第 21 条）', async () => {
    await seedDisputed('o-1');
    await markDisputeClosed(db, createEventBus(SILENT), 'o-1', {
      channel: 'stripe',
      disputeId: 'dp_1',
      result: 'won',
    });
    const rows = await createRiskAdminRepo(db).listDisputes('won');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.disputeStatus).toBe('won');
    // 且不再出现在"进行中"的筛选里
    expect(await createRiskAdminRepo(db).listDisputes('open')).toHaveLength(0);
  });
});

describe('markOrderDisputed：拒绝路径（每一条都要能进对账）', () => {
  it('订单不存在 → 40400（由管线按宽限期分层，不是在这里吞掉）', async () => {
    await expect(
      markOrderDisputed(db, createEventBus(SILENT), SILENT, 'nope', dispute()),
    ).rejects.toMatchObject({ code: 40400 });
  });

  it('没有 succeeded 的支付行 → 40902 no_succeeded_payment', async () => {
    await seedPaid('o-1');
    await db`update payments set status = 'initiated' where order_id = 'o-1'`;
    await expect(
      markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute()),
    ).rejects.toMatchObject({ code: 40902 });
    // 且什么都没写
    expect((await orderRow('o-1'))['has_dispute']).toBe(false);
  });

  it('通道不符 → 40902 channel_mismatch（持别家密钥不能给我方订单打拒付标记）', async () => {
    await seedPaid('o-1');
    await expect(
      markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute({ channel: 'wechat' })),
    ).rejects.toMatchObject({ code: 40902 });
  });

  /**
   * A4（AJ-189）：金额不符**照常落库**，落的是**机构报的数**，并留一条 warn。
   *
   * @why 旧实现拒绝落库的后果不是"多一条错误日志"，而是**这条拒付消失**：
   *      `has_dispute` 不置位 → 退款/发货闸门照开 → 钱被扣回去了我们还在退款。
   *      所以这里钉的是"闸门真的关上了"（风控列表读得到 + has_dispute=true），
   *      而不只是"没抛错"。
   */
  it('A4：金额不符（部分争议 / 汇率波动）→ 照常落库，落机构报的金额 + warn 留痕', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'test', destination: sink });
    await seedPaid('o-1', { amount: 1000 });
    await markOrderDisputed(
      db,
      createEventBus(SILENT),
      logger,
      'o-1',
      dispute({ amountMinor: 700 }),
    );
    // 落的是机构说的 700，不是我们的扣款额 1000
    expect((await paymentRow('o-1'))['dispute_amount']).toBe(700);
    // 闸门必须关上：这才是"拒付真的进了系统"的判据
    expect((await orderRow('o-1'))['has_dispute']).toBe(true);
    const disputes = await createRiskAdminRepo(db).listDisputes();
    expect(disputes.map((r) => r.disputeId)).toContain('dp_1');
    const warns = sink.find('dispute_amount_differs');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.['ctx']).toMatchObject({
      charge_amount: 1000,
      dispute_amount: 700,
      diff: -300,
    });
  });

  it('金额不符但已退款的支付行 → 仍走 no_succeeded_payment（不因为有争议就放宽前置）', async () => {
    await seedPaid('o-1', { amount: 1000 });
    await db`update payments set status = 'refunded' where order_id = 'o-1'`;
    await expect(
      markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute({ amountMinor: 700 })),
    ).rejects.toMatchObject({ code: 40902 });
  });

  it('币种不符 → 40902 currency_mismatch', async () => {
    await seedPaid('o-1', { currency: 'USD' });
    await expect(
      markOrderDisputed(db, createEventBus(SILENT), SILENT, 'o-1', dispute({ currency: 'JPY' })),
    ).rejects.toMatchObject({ code: 40902 });
  });

  it('🔴 机构没给开案时刻 → 40902 dispute_unverifiable，**不落库**', async () => {
    /**
     * @why 不降级成"用入库时刻顶上"：那会让举证期限被算短，
     *      且看起来一切正常（`dispute_opened_at` 有值、只是错的）。
     *      拒付没有开案时刻 = 这条拒付**不可用**，必须转对账由人工处理。
     */
    await seedPaid('o-1');
    await expect(
      markOrderDisputed(
        db,
        createEventBus(SILENT),
        SILENT,
        'o-1',
        dispute({ openedAtMs: undefined }),
      ),
    ).rejects.toMatchObject({ code: 40902 });
    expect((await paymentRow('o-1'))['dispute_id']).toBeNull();
    expect(await events('o-1')).toEqual([]);
  });

  it('金额或币种缺失 → 同样 dispute_unverifiable（不跳过核对）', async () => {
    await seedPaid('o-1');
    await expect(
      markOrderDisputed(
        db,
        createEventBus(SILENT),
        SILENT,
        'o-1',
        dispute({ amountMinor: undefined }),
      ),
    ).rejects.toMatchObject({ code: 40902 });
    await expect(
      markOrderDisputed(
        db,
        createEventBus(SILENT),
        SILENT,
        'o-1',
        dispute({ currency: undefined }),
      ),
    ).rejects.toMatchObject({ code: 40902 });
  });

  it('抛的是 AppError：details.reason 落进 reason，管线据此分诊', async () => {
    await seedPaid('o-1');
    const err = await markOrderDisputed(
      db,
      createEventBus(SILENT),
      SILENT,
      'o-1',
      dispute({ openedAtMs: undefined }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).details).toMatchObject({ reason: 'dispute_unverifiable' });
  });
});
