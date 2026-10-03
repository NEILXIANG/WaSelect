/**
 * 职责：`executeRefund` 的**错误分诊**用例（AJ-313）。
 *
 * @why 单独一个文件而不是并进 admin-order-routes 的用例：那里测的是"退款整条链路成不成"，
 *      而这里测的是**同一个异常该被说成什么**——两种失败在 HTTP 层只差一个码
 *      （50000 vs 50300），却是两个相反的运营动作（"去查我们的系统" vs "等一会儿再点一次"）。
 *      混在链路用例里，这种差别会被"反正都失败了"盖住。
 *
 * @why 用**会计数**的 Db 替身而不是真库：被熔断拒绝的那条路径一次库都不该碰
 *      （请求在出发前就被拦下），而"没写 `refund_failed` 事件"正是本条要断言的一半。
 *      计数器让"没碰库"变成可断言的事实，不是注释里的一句话。
 *
 * @limitation 只钉"被熔断拒绝"这一类的分诊；其余三态（succeeded / pending / failed）
 *      由 admin-order-routes 的真库用例与 F-03 的用例覆盖，这里不重复。
 *
 * DB2-09：本文件随后补了三条"**出口**"用例（通道不支持退款 / 查在途时被熔断 /
 *      事件写不进去）。@why 这三条原先一行都没覆盖，而它们各自是一个**独立出口**：
 *      不是"退款成不成"，而是"这条路上还有别的门，那扇门关着时说的是什么"。
 *      它们与上面三条共用同一个计数 Db，所以"碰没碰库"仍然是可断言的事实。
 */
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { AppError } from '../errors.js';
import { CircuitOpenError } from '../ports/circuit-breaker.js';
import type { Db } from '../adapters/db.js';
import type { PaymentProvider, RefundResult } from '../ports/payment.js';
import { executeRefund, type RefundExecDeps, type RefundPlan } from './refund-execution.js';

const CLOCK = fixedClock('2026-01-02T12:00:00.000Z');

/** 计数用的 Db 替身：每次被调用 `n += 1`（`recordRefundFailed` 走的就是它）。 */
function fakeDb(counter: { n: number }): Db {
  const fn = (): Promise<unknown[]> => {
    counter.n += 1;
    return Promise.resolve([]);
  };
  return fn as unknown as Db;
}

function deps(counter: { n: number }): { d: RefundExecDeps; sink: MemorySink } {
  const sink = new MemorySink();
  return {
    d: {
      db: fakeDb(counter),
      logger: createLogger({ env: 'test', destination: sink }),
      clock: CLOCK,
    },
    sink,
  };
}

/** 造一个"能退也能查"的假通道；`refundThrow` 用来注入这一次要抛的东西。 */
function provider(refundThrow: unknown): PaymentProvider {
  return {
    channel: 'stripe',
    capabilities: {
      currencies: ['JPY'],
      countries: ['*'],
      entryMode: 'copylink',
      supportsRefund: true,
      supportsPartialRefund: false,
      supportsDispute: true,
      refundableWhenDisabled: true,
    },
    refund: () => {
      if (refundThrow !== undefined) return Promise.reject(refundThrow);
      return Promise.resolve<RefundResult>({
        providerRef: 'cs_1',
        refundRef: 're_1',
        outcome: 'succeeded',
      });
    },
    refundStatus: () => Promise.resolve<RefundResult['outcome']>('succeeded'),
    parseWebhook: () => Promise.reject(new Error('unused')),
    create: () => Promise.reject(new Error('unused')),
  };
}

/**
 * 一个**不支持退款**的通道（`refund` / `refundStatus` 都没实现）。
 * @why 这两个方法在端口上是**可选**的（ports/payment.ts @limitation 三），
 *      注册表只强制"能退就必须能查"，不强制"必须能退"——所以这个形状是合法的，
 *      而且正是"老通道下线后换了个不支持退款的新通道"时的形状。
 */
function providerWithoutRefund(): PaymentProvider {
  return {
    channel: 'stripe',
    capabilities: {
      currencies: ['JPY'],
      countries: ['*'],
      entryMode: 'copylink',
      supportsRefund: false,
      supportsPartialRefund: false,
      supportsDispute: false,
      refundableWhenDisabled: false,
    },
    parseWebhook: () => Promise.reject(new Error('unused')),
    create: () => Promise.reject(new Error('unused')),
  };
}

function plan(): RefundPlan {
  return {
    orderId: 'o-1',
    paymentId: 'pay-o-1',
    channel: 'stripe',
    request: {
      orderId: 'o-1',
      providerRef: 'cs_1',
      amountJpy: 12_000,
      currency: 'JPY',
      amountMinor: 12_000,
      reason: '缺货',
    },
    progress: { pendingRef: null, confirmedFailures: 0 },
    actor: 'admin:u-1',
    hasDispute: false,
  };
}

describe('executeRefund：被熔断拒绝 ≠ 机构失败（AJ-313）', () => {
  /**
   * @why 熔断拒绝是"**我们**主动没发"，它自带"约 N ms 后可重试"。折成 50000 会同时丢掉两件事：
   *      ① 可重试的时刻；② "上游在恢复"这个语义——管理员看到"服务器内部错误"会去查我们的系统，
   *      而事实是上游刚在故障里。发起支付那边是原样抛的（pay-intent.ts 的 `createSessionOr50001`
   *      明令"熔断 CircuitOpenError 原样抛——翻成 50001 会丢掉重试时刻"），这里必须同口径。
   */
  it('🔴 refund 抛 CircuitOpenError → **原样**抛（不是 50000），保留 retry_after_ms', async () => {
    const counter = { n: 0 };
    const { d } = deps(counter);
    const boom = new CircuitOpenError('api.stripe.com', 23_000);
    const err = await executeRefund(d, provider(boom), plan()).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect((err as CircuitOpenError).retryAfterMs).toBe(23_000);
  });

  /**
   * @why 反面的一半：不能记 `refund_failed` 事件。它一旦被记下，事件流就写着"机构失败了"，
   *      而机构根本没被问过——排障的人会照着"机构侧出问题"去查。
   *      ⚠️ 它**不会**换幂等键（`findRefundProgress` 只数 `provider_failed:*`），
   *      所以这里守的不是钱的重复，是**事件流的诚实**。
   */
  it('🔴 且**不写** refund_failed 事件（一次库都没碰：请求在出发前就被拦下了）', async () => {
    const counter = { n: 0 };
    const { d, sink } = deps(counter);
    await expect(
      executeRefund(d, provider(new CircuitOpenError('api.stripe.com', 1_000)), plan()),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(counter.n, '被熔断拒绝的路径不应写任何事件').toBe(0);
    // 落在日志里的处置是"延后"，不是"失败"
    const rows = sink.find('admin_order_refund_circuit_open');
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.result)).toBe('deferred');
    expect(sink.find('admin_order_refund_failed')).toHaveLength(0);
  });

  /**
   * 反向：真正发了请求之后的失败**仍然**是 50000 + `provider_error`（要写事件）。
   * @why 只钉"熔断那一条"会留下另一种错法：把"结果未知"也当成"被熔断"放行，
   *      于是超时（钱可能已经退了）也变成"稍后再试"，而它恰恰**不该**换键重试（KD-4）。
   *      这条把两类分开——熔断放行、超时不放行——同一个计数器在两种情形下给出两个数。
   */
  it('反向：超时这类"结果未知"仍然是 50000 且写 refund_failed（不会被误当成熔断）', async () => {
    const counter = { n: 0 };
    const { d } = deps(counter);
    const err = await executeRefund(d, provider(new Error('fetch failed')), plan()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(50000);
    expect(counter.n, '结果未知必须留痕（否则下一次点击无从判断换不换键）').toBe(1);
  });
});

describe('executeRefund：另外三个出口（DB2-09）', () => {
  /**
   * @why `refund` / `refundStatus` 是**可选**方法，所以"通道不支持退款"是一个合法状态，
   *      而且它只在**有人点了退款**时才暴露——平时完全看不出来（通道照常能建单、能收回调）。
   *      这条没被钉住的形态是：把"不支持"静默当成"成功"或"待处理"，
   *      于是管理员看到 200 / pending，钱其实一分没退（AJ-37 禁止的"不报错的错"）。
   */
  it('🔴 通道没有 refund / refundStatus → 50000 refund_not_supported，且一次库都不碰', async () => {
    const counter = { n: 0 };
    const { d } = deps(counter);
    const err = await executeRefund(d, providerWithoutRefund(), plan()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(50000);
    expect((err as AppError).details).toMatchObject({ reason: 'refund_not_supported' });
    expect(counter.n, '还没发起任何请求，不该落任何事件').toBe(0);
  });

  /**
   * @why 与"发起退款被熔断"**同口径的另一半**（AJ-313 只钉了发起那半）：
   *      查询在途那笔时被熔断拦下，同样是"我们没问成"，不是"机构答复了"。
   *      折成 50000 会丢掉重试时刻，而这条路的**唯一出口就是再点一次查询**
   *      ——管理员看到"服务器内部错误"会以为退款已经坏了，进而去做手工改库这类更危险的事。
   */
  it('🔴 查在途那笔时被熔断拦下 → **原样**抛 + deferred 日志，不写事件（不是 50000）', async () => {
    const counter = { n: 0 };
    const { d, sink } = deps(counter);
    const boom = new CircuitOpenError('api.stripe.com', 7_000);
    const p = provider(undefined);
    p.refundStatus = () => Promise.reject(boom);
    const err = await executeRefund(d, p, {
      ...plan(),
      progress: { pendingRef: 're_1', confirmedFailures: 0 },
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(counter.n, '被熔断拒绝的查询不该写 refund_failed').toBe(0);
    const rows = sink.find('admin_order_refund_status_circuit_open');
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.result)).toBe('deferred');
    expect(rows[0]?.['ctx']).toMatchObject({ retry_after_ms: 7_000 });
    expect(sink.find('admin_order_refund_failed')).toHaveLength(0);
  });

  /**
   * @why 事件是 **best-effort**：它只用于"下一次点击该不该换键"的判断与排障，
   *      不是钱的那条路。写不进去时正确的处置是"记一笔 not_written、退款照旧报 50000"，
   *      而不是让整次请求因为审计写失败而变成另一种错误（那会让管理员以为退款成功了）。
   *      ⚠️ 这条也是上面三条的补集：它们都断言"事件没写"，这一条断言"**想写但没写成**"。
   */
  it('🔴 refund_failed 事件写不进去 → 记 not_written 日志，仍然抛 50000（事件是 best-effort）', async () => {
    const sink = new MemorySink();
    const d: RefundExecDeps = {
      db: ((): never => {
        throw new Error('模拟事件写入失败');
      }) as unknown as Db,
      logger: createLogger({ env: 'test', destination: sink }),
      clock: CLOCK,
    };
    const err = await executeRefund(d, provider(new Error('fetch failed')), plan()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(50000);
    expect(sink.find('admin_order_refund_failed')).toHaveLength(1);
    expect(sink.find('admin_order_refund_failed_event_not_written')).toHaveLength(1);
  });
});
