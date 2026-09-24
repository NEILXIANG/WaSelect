/**
 * 职责：webhooks.ts 的 L0 单测——只覆盖**无法用真库到达**的防御分支（N16 定向）。
 * 真库行为一律在 webhooks.db.test.ts，本文件不复制。
 */
import { describe, expect, it } from 'vitest';
import { claimWebhookEvent } from './webhooks.js';
import type { Db } from './db.js';

describe('claimWebhookEvent 防御分支（N16 定向）', () => {
  it('insert 冲突后 select 仍查不到行（竞态：行在两次调用间被删）→ 保守按首次、锚点给当前时间', async () => {
    // @why 这条路径在真库里**编排不出来**：它要求"on conflict 撞到了行"与"select 查不到行"
    //      同时成立——中间只有一次并发删除的窗口（如清理任务恰好删掉）。用桩 db 直接走到，
    //      钉住防御语义：当作首次处理、宽限期锚点给当前时间，而不是抛错让回调丢失。
    let calls = 0;
    const stub = (() => {
      calls += 1;
      return Promise.resolve([]);
    }) as unknown as Db;

    const r = await claimWebhookEvent(stub, { provider: 'mock', eventId: 'e-1', hash: 'h' });
    // N22 之后是三步：insert（冲突返回 0 行）→ 接管 update（也 0 行）→ select（也 0 行）
    expect(calls).toBe(3);
    expect(r.state).toBe('new');
    // 兜底分支也要给令牌：它按"本次应当处理"返回，后续 finish 才有栅栏可验
    expect(r.token).toBeDefined();
    expect(Math.abs(Date.now() - r.firstReceivedAt.getTime())).toBeLessThan(5_000);
  });
});
