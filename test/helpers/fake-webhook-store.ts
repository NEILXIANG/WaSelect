/**
 * 职责：测试用的**桩回调存储**（`WebhookStore`）——记录调用、可编排登记结果。
 *
 * @why 抽成 helper 而不是在两处各写一份：`app/pay-callback` 的管线用例与
 *      `app/pay-routes` 的路由用例都需要它，而"四态 + 宽限期锚点 + 栅栏返回值"
 *      这套桩的**语义**（什么时候给 token、nowAt 与 firstReceivedAt 怎么差）
 *      本身就是契约的一部分。复制两份之后，改了一边的语义另一边就变成假绿灯——
 *      而它恰好是用来验证"钱有没有落账"的那套桩。
 *
 * @why 不直接 mock `createWebhookStore`：真库的四态并发语义编排不出来
 *      （N16 同一类理由），而这里要验的是"管线在各种登记结果下怎么走"。
 *
 * @limitation **只记录，不模拟并发**：多个请求同时 claim 同一个 event_id 的
 *              真实竞态不在这里覆盖，那属 `adapters/webhooks.db.test.ts`。
 */
import type {
  ClaimResult,
  ClaimState,
  WebhookEventInput,
  WebhookStore,
} from '../../server/src/ports/webhooks.js';

/**
 * 宽限期算术的固定锚点。
 * @why 用常量而不是 `new Date()`：宽限期断言必须可重复写出（"elapsed = 0" 那条用例
 *      就是要钉住"零宽限"语义），用当前时间会让断言随运行时刻漂移。
 */
export const FAKE_FIRST_RECEIVED_AT = new Date('2026-01-02T00:00:00.000Z');

export interface WebhookRecorder {
  /** 每次 claim 的入参。 */
  claimed: WebhookEventInput[];
  /** 每次 finish 的结果与令牌。 */
  finished: Array<{ result: string; token: string; note?: string | undefined }>;
  /** 每次 releaseLease 的令牌。 */
  released: string[];
}

export interface FakeStoreOptions {
  /** claim 返回的登记态，默认 `new`。 */
  state?: ClaimState;
  /** `nowAt - firstReceivedAt` 的毫秒数（宽限期算术的输入），默认 0。 */
  elapsedMs?: number;
  /** `finish` 的返回值（false = 模拟租约易主），默认 true。 */
  finishReturns?: boolean;
  /**
   * 覆盖默认令牌（`new`/`retry` 时才有值）。
   *
   * ⚠️ 用 `'token' in opts` 判断而不是 `opts.token !== undefined`：
   *    必须能区分"**没传**"（走默认）与"**显式传了 undefined**"
   *    （模拟"登记实现违反不变式：new/retry 却没给令牌"——pay-callback.ts 对这种情况
   *    是响亮失败而不是静默兜底，那条分支需要被真实走到）。
   */
  token?: string | undefined;
}

/** 造一个桩存储；返回的 `rec` 供用例断言"管线到底让它做了什么"。 */
export function fakeWebhookStore(opts: FakeStoreOptions = {}): {
  store: WebhookStore;
  rec: WebhookRecorder;
} {
  const rec: WebhookRecorder = { claimed: [], finished: [], released: [] };
  const state = opts.state ?? 'new';
  const token =
    'token' in opts ? opts.token : state === 'new' || state === 'retry' ? 'tok-1' : undefined;

  const store: WebhookStore = {
    async claim(input) {
      rec.claimed.push(input);
      const result: ClaimResult = {
        state,
        firstReceivedAt: FAKE_FIRST_RECEIVED_AT,
        nowAt: new Date(FAKE_FIRST_RECEIVED_AT.getTime() + (opts.elapsedMs ?? 0)),
        ...(token !== undefined ? { token } : {}),
      };
      return result;
    },
    async finish(input) {
      rec.finished.push({ result: input.result, token: input.token, note: input.note });
      return opts.finishReturns ?? true;
    },
    async releaseLease(input) {
      rec.released.push(input.token);
      return true;
    },
  };
  return { store, rec };
}
