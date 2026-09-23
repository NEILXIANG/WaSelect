/**
 * 职责：回调登记与去重的真库测试（D3 回调侧）。
 *
 * @why 去重的核心保证是 **UNIQUE (provider, event_id)**，而它是否真的存在、是否真的会拦，
 *      只有往真库插两遍才知道。用 mock 掉的 db 测"返回 false"等于没测——
 *      那条 false 可能来自任何一段代码，而不是唯一约束。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { claimWebhookEvent, finishWebhookEvent, payloadHash } from './webhooks.js';
import { ensureTestDb, resetTestDb, testDb } from '../../test/db/test-db.js';

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
});

const event = (eventId: string) => ({
  provider: 'mock',
  eventId,
  eventType: 'payment.succeeded',
  hash: payloadHash(`payload-${eventId}`),
});

describe('claimWebhookEvent', () => {
  it('首次投递 = new，处理完成后重复投递 = handled（去重靠唯一约束，不是先查后插）', async () => {
    await expect(claimWebhookEvent(db, event('evt-1'))).resolves.toMatchObject({ state: 'new' });
    await finishWebhookEvent(db, { ...event('evt-1'), result: 'paid' });
    await expect(claimWebhookEvent(db, event('evt-1'))).resolves.toMatchObject({
      state: 'handled',
    });
  });

  it('不同 provider 的同名事件互不干扰', async () => {
    await expect(claimWebhookEvent(db, event('evt-1'))).resolves.toMatchObject({ state: 'new' });
    await expect(
      claimWebhookEvent(db, { ...event('evt-1'), provider: 'stripe' }),
    ).resolves.toMatchObject({ state: 'new' });
  });

  it('并发投递只有一个拿到 new（竞态下也不能重复处理）', async () => {
    const results = await Promise.all([
      claimWebhookEvent(db, event('evt-race')),
      claimWebhookEvent(db, event('evt-race')),
      claimWebhookEvent(db, event('evt-race')),
    ]);
    expect(results.filter((r) => r.state === 'new')).toHaveLength(1);
  });

  /**
   * firstReceivedAt 是宽限期的锚点（AJ-32）：无论重发多少次，都必须一直是**首次**到达时间。
   * @why 宽限期判断"距首次到达是否超时"依赖这个值；若它在重发时被刷新，
   *      机构每次重发都会把宽限期重新归零 → 脏回调永远走 503、永远落不了 unmatched。
   */
  it('firstReceivedAt 始终是首次到达时间（重发不刷新宽限期锚点）', async () => {
    const first = await claimWebhookEvent(db, event('evt-anchor'));
    await new Promise((r) => setTimeout(r, 50));
    const second = await claimWebhookEvent(db, event('evt-anchor'));
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
  it('上次处理到一半崩了（processed_at 为空）→ 重发时可以再处理', async () => {
    await expect(claimWebhookEvent(db, event('evt-crash'))).resolves.toMatchObject({
      state: 'new',
    });
    await expect(claimWebhookEvent(db, event('evt-crash'))).resolves.toMatchObject({
      state: 'retry',
    });
  });

  it('超过宽限期落了 unmatched → 终态 handled，不再重试（转对账而非重发）', async () => {
    await claimWebhookEvent(db, event('evt-late'));
    await finishWebhookEvent(db, { ...event('evt-late'), result: 'unmatched:order_not_found' });
    await expect(claimWebhookEvent(db, event('evt-late'))).resolves.toMatchObject({
      state: 'handled',
    });
  });

  it('状态冲突（status_conflict）不重试——重发一万次也不会变', async () => {
    await claimWebhookEvent(db, event('evt-conflict'));
    await finishWebhookEvent(db, { ...event('evt-conflict'), result: 'ignored:status_conflict' });
    await expect(claimWebhookEvent(db, event('evt-conflict'))).resolves.toMatchObject({
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
    await expect(claimWebhookEvent(db, noType)).resolves.toMatchObject({ state: 'new' });
    // 库里应落 NULL 而不是崩——且重复投递照常去重
    await expect(claimWebhookEvent(db, noType)).resolves.toMatchObject({ state: 'retry' });
  });

describe('finishWebhookEvent', () => {
  it('处理完回填 processed_at 与 result', async () => {
    await claimWebhookEvent(db, event('evt-2'));
    await finishWebhookEvent(db, { ...event('evt-2'), result: 'paid' });
    const rows = await db`select result, processed_at from webhook_events where event_id = 'evt-2'`;
    expect(rows[0]?.result).toBe('paid');
    expect(rows[0]?.processed_at).not.toBeNull();
  });

  it('业务冲突同样留痕（result 供对账区分"处理过"与"没处理"）', async () => {
    await claimWebhookEvent(db, event('evt-3'));
    await finishWebhookEvent(db, {
      ...event('evt-3'),
      result: 'unmatched:order_not_found',
      note: '订单不存在',
    });
    const rows = await db`select result, note from webhook_events where event_id = 'evt-3'`;
    expect(rows[0]?.result).toBe('unmatched:order_not_found');
    expect(rows[0]?.note).toBe('订单不存在');
  });

  it('未处理的事件 processed_at 为空——这正是"待对账"信号', async () => {
    await claimWebhookEvent(db, event('evt-4'));
    const rows = await db`select processed_at from webhook_events where event_id = 'evt-4'`;
    expect(rows[0]?.processed_at).toBeNull();
  });
});

describe('payloadHash', () => {
  it('相同内容得到相同摘要，不同内容不同（且**不落原文**）', () => {
    expect(payloadHash(Buffer.from('abc'))).toBe(payloadHash('abc'));
    expect(payloadHash('abc')).not.toBe(payloadHash('abd'));
    expect(payloadHash('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});
