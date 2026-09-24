/**
 * 职责：回调登记与去重的真库测试（D3 回调侧）。
 *
 * @why 去重的核心保证是 **UNIQUE (provider, event_id)**，而它是否真的存在、是否真的会拦，
 *      只有往真库插两遍才知道。用 mock 掉的 db 测"返回 false"等于没测——
 *      那条 false 可能来自任何一段代码，而不是唯一约束。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { createWebhookStore, payloadHash } from './webhooks.js';
import type { WebhookStore } from '../ports/webhooks.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';

let db: Db;
let store: WebhookStore;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  // 与生产同一条装配路径：实现只在装配处出现一次，之后业务侧只见端口
  store = createWebhookStore(db);
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
});

const event = (eventId: string) => ({
  provider: 'mock',
  eventId,
  eventType: 'payment.succeeded',
  hash: payloadHash(`payload-${eventId}`),
});

describe('claimWebhookEvent', () => {
  it('首次投递 = new，处理完成后重复投递 = handled（去重靠唯一约束，不是先查后插）', async () => {
    const first = await store.claim(event('evt-1'));
    expect(first.state).toBe('new');
    expect(
      await store.finish({ ...event('evt-1'), result: 'paid', token: first.token ?? '' }),
    ).toBe(true);
    await expect(store.claim(event('evt-1'))).resolves.toMatchObject({
      state: 'handled',
    });
  });

  it('不同 provider 的同名事件互不干扰', async () => {
    await expect(store.claim(event('evt-1'))).resolves.toMatchObject({ state: 'new' });
    await expect(store.claim({ ...event('evt-1'), provider: 'stripe' })).resolves.toMatchObject({
      state: 'new',
    });
  });

  /**
   * N22：并发投递时"只有一个 new"**不够**——还必须说清另外两个是什么。
   * 修前三态里它们是 `retry`（因为 `processed_at IS NULL`），于是三个请求都会去处理
   * 同一个事件：事件行的 result 被后写完的覆盖，"这条回调到底怎么处理的"就说不清了，
   * 而这张表存在的唯一理由就是举证。
   * 修后它们必须是 `inflight`（有人正持有租约），只有持有者本人处理、其余回 503 让机构重发。
   */
  it('并发投递：一个 new，其余必须是 inflight（正在处理中，不许第二个也去处理）', async () => {
    const results = await Promise.all([
      store.claim(event('evt-race')),
      store.claim(event('evt-race')),
      store.claim(event('evt-race')),
    ]);
    expect(results.filter((r) => r.state === 'new')).toHaveLength(1);
    expect(results.filter((r) => r.state === 'inflight')).toHaveLength(2);
    expect(results.filter((r) => r.state === 'retry')).toHaveLength(0);
    // 只有持有者拿到令牌：没令牌就不该写结果（finish 的栅栏条件）
    expect(results.filter((r) => r.token !== undefined)).toHaveLength(1);
  });

  /**
   * @why 租约的**另一半**语义：过期后必须允许接管，否则一次崩溃会把这个 event_id
   *      永久钉在 inflight 上——机构重发多少次都拿不到处理，只能等 F13 对账。
   *      这条与上面那条是一对，缺任一条租约都不成立。
   */
  it('崩溃遗留（租约已过期）→ retry 并可接管，不被误判成 inflight', async () => {
    const first = await store.claim(event('evt-crash'));
    expect(first.state).toBe('new');
    // 模拟"处理到一半进程死了"：租约留在过去
    await db`
      update webhook_events
         set processing_until = now() - interval '1 minute'
       where event_id = 'evt-crash'
    `;
    const second = await store.claim(event('evt-crash'));
    expect(second.state).toBe('retry');
    expect(second.token).toBeDefined();
    // 接管后租约刷新：紧接着的第三次投递应被挡在 inflight
    const third = await store.claim(event('evt-crash'));
    expect(third.state).toBe('inflight');
  });

  it('处理完成后重复投递 = handled，与是否持有租约无关', async () => {
    const first = await store.claim(event('evt-done'));
    await store.finish({
      ...event('evt-done'),
      result: 'paid',
      token: first.token ?? '',
    });
    const again = await store.claim(event('evt-done'));
    expect(again.state).toBe('handled');
    expect(again.token).toBeUndefined();
  });

  /**
   * firstReceivedAt 是宽限期的锚点（AJ-32）：无论重发多少次，都必须一直是**首次**到达时间。
   * @why 宽限期判断"距首次到达是否超时"依赖这个值；若它在重发时被刷新，
   *      机构每次重发都会把宽限期重新归零 → 脏回调永远走 503、永远落不了 unmatched。
   */
  it('firstReceivedAt 始终是首次到达时间（重发不刷新宽限期锚点）', async () => {
    const first = await store.claim(event('evt-anchor'));
    await new Promise((r) => setTimeout(r, 50));
    const second = await store.claim(event('evt-anchor'));
    expect(second.firstReceivedAt.getTime()).toBe(first.firstReceivedAt.getTime());
  });

  /**
   * 三态里的 `retry` 是**正确性**条款，不是优化。
   * @why 见 webhooks.ts 的 @why：回调比订单先到时，机构重发的是**同一个** event_id。
   *      若按"见过就算重复"直接返回，这张单永远不会被标记成已支付——
   *      那是"钱到了但订单没变 paid"，最贵的一类事故。去重要给它让路。
   *      AJ-32 之后 retry 的唯一来源是 `processed_at IS NULL`
   *      （处理中途崩溃 / 宽限期内 503 主动不封口）。
   */
  /**
   * N22 之前这条用例写的是"登记过没处理完 → 重发就 retry"，那正是缺陷本身：
   * 它把"**有人正在处理**"也算成了 retry，于是并发时第二个请求也会去处理。
   * 现在必须分开：租约未过期 = inflight（不许碰），只有租约过期（真崩溃遗留）才 retry。
   */
  it('处理到一半崩了：租约未过期 = inflight，租约过期后 = retry（可接管）', async () => {
    await expect(store.claim(event('evt-crash'))).resolves.toMatchObject({
      state: 'new',
    });
    // 持有人在租约内：重发不许插手
    await expect(store.claim(event('evt-crash'))).resolves.toMatchObject({
      state: 'inflight',
    });
    // 租约过期（持有人崩了）→ 允许接管
    await db`update webhook_events set processing_until = now() - interval '1 second' where event_id = 'evt-crash'`;
    await expect(store.claim(event('evt-crash'))).resolves.toMatchObject({
      state: 'retry',
    });
  });

  it('超过宽限期落了 unmatched → 终态 handled，不再重试（转对账而非重发）', async () => {
    const c = await store.claim(event('evt-late'));
    await store.finish({
      ...event('evt-late'),
      result: 'unmatched:order_not_found',
      token: c.token ?? '',
    });
    await expect(store.claim(event('evt-late'))).resolves.toMatchObject({
      state: 'handled',
    });
  });

  it('状态冲突（status_conflict）不重试——重发一万次也不会变', async () => {
    const c = await store.claim(event('evt-conflict'));
    await store.finish({
      ...event('evt-conflict'),
      result: 'ignored:status_conflict',
      token: c.token ?? '',
    });
    await expect(store.claim(event('evt-conflict'))).resolves.toMatchObject({
      state: 'handled',
    });
  });
});

it('无 event_type 的事件也能登记（骨架模拟回调没有类型字段；`?? null` 分支，N16 定向）', async () => {
  const noType: { provider: string; eventId: string; hash: string } = {
    provider: 'mock',
    eventId: 'evt-notype',
    hash: payloadHash('payload-evt-notype'),
  };
  await expect(store.claim(noType)).resolves.toMatchObject({ state: 'new' });
  // 库里应落 NULL 而不是崩——且重复投递照常去重
  await expect(store.claim(noType)).resolves.toMatchObject({ state: 'inflight' });
});

describe('finishWebhookEvent', () => {
  it('处理完回填 processed_at 与 result', async () => {
    const c = await store.claim(event('evt-2'));
    await store.finish({ ...event('evt-2'), result: 'paid', token: c.token ?? '' });
    const rows = await db`select result, processed_at from webhook_events where event_id = 'evt-2'`;
    expect(rows[0]?.result).toBe('paid');
    expect(rows[0]?.processed_at).not.toBeNull();
  });

  it('业务冲突同样留痕（result 供对账区分"处理过"与"没处理"）', async () => {
    const c = await store.claim(event('evt-3'));
    await store.finish({
      ...event('evt-3'),
      token: c.token ?? '',
      result: 'unmatched:order_not_found',
      note: '订单不存在',
    });
    const rows = await db`select result, note from webhook_events where event_id = 'evt-3'`;
    expect(rows[0]?.result).toBe('unmatched:order_not_found');
    expect(rows[0]?.note).toBe('订单不存在');
  });

  it('未处理的事件 processed_at 为空——这正是"待对账"信号', async () => {
    await store.claim(event('evt-4'));
    const rows = await db`select processed_at from webhook_events where event_id = 'evt-4'`;
    expect(rows[0]?.processed_at).toBeNull();
  });
});

/**
 * releaseWebhookLease（N22 的补丁）
 *
 * @why 加租约时漏了"主动交还"这一环，是**自己的 e2e 把它抓出来的**：
 *      "回调比订单先到"走 `503 让机构重发`，那个请求到此就结束了、并不在处理，
 *      租约却还挂在它名下 10 秒 → 接下来 10 秒内的重投全被判成 inflight 再吃 503，
 *      "早到 → 重发 → 补上"整条链被租约自己掐断。租约的语义是"**我正在处理**"，
 *      不是"我见过这条"——决定不处理就必须交还。
 */
describe('releaseWebhookLease', () => {
  it('交还后下一次投递立刻可接管（不是 inflight）——早到回调的重发必须能补上', async () => {
    const first = await store.claim(event('evt-release'));
    expect(first.state).toBe('new');
    // 交还前：并发投递被挡住（这是租约该做的事）
    await expect(store.claim(event('evt-release'))).resolves.toMatchObject({
      state: 'inflight',
    });

    expect(await store.releaseLease({ ...event('evt-release'), token: first.token ?? '' })).toBe(
      true,
    );

    // 交还后：租约没了，下一次投递必须能接管（processed_at 仍 NULL → retry）
    const next = await store.claim(event('evt-release'));
    expect(next.state).toBe('retry');
    expect(next.token).toBeDefined();
  });

  it('交还只清租约，不动 processed_at（待办信号必须留着）', async () => {
    const c = await store.claim(event('evt-release2'));
    await store.releaseLease({ ...event('evt-release2'), token: c.token ?? '' });
    const rows = await db`
      select processed_at, processing_until, processing_token
        from webhook_events where event_id = 'evt-release2'
    `;
    expect(rows[0]?.processed_at).toBeNull();
    expect(rows[0]?.processing_until).toBeNull();
    expect(rows[0]?.processing_token).toBeNull();
  });

  /**
   * 栅栏：迟到的旧持有者不能把**新持有者**的租约清掉。
   * @why 令牌失效有两种情形（租约过期被接管 / 该行已封口），
   *      两种都返回 false 且**不需要补偿**——前者已有人在接管处理，后者本就是终态。
   */
  it('令牌已失效（别人接管了）→ false，且不破坏新持有者的租约', async () => {
    const first = await store.claim(event('evt-fence'));
    // 模拟租约过期被接管
    await db`update webhook_events set processing_until = now() - interval '1 second' where event_id = 'evt-fence'`;
    const second = await store.claim(event('evt-fence'));
    expect(second.state).toBe('retry');

    expect(await store.releaseLease({ ...event('evt-fence'), token: first.token ?? '' })).toBe(
      false,
    );
    // 新持有者的租约完好：第三次投递仍被挡在 inflight
    await expect(store.claim(event('evt-fence'))).resolves.toMatchObject({
      state: 'inflight',
    });
  });

  it('已封口的事件（processed_at 非空）不被交还影响', async () => {
    const c = await store.claim(event('evt-sealed'));
    await store.finish({ ...event('evt-sealed'), result: 'paid', token: c.token ?? '' });
    expect(await store.releaseLease({ ...event('evt-sealed'), token: c.token ?? '' })).toBe(false);
    const rows = await db`select result from webhook_events where event_id = 'evt-sealed'`;
    expect(rows[0]?.result).toBe('paid');
  });
});

describe('payloadHash', () => {
  it('相同内容得到相同摘要，不同内容不同（且**不落原文**）', () => {
    expect(payloadHash(Buffer.from('abc'))).toBe(payloadHash('abc'));
    expect(payloadHash('abc')).not.toBe(payloadHash('abd'));
    expect(payloadHash('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});
