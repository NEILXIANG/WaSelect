/**
 * 职责：身份缓存的**纯单测**（不需要真库）——只钉"缓存与作废的时序"。
 *
 * @why 真库用例（`identity.db.test.ts`）验的是"查出来的值对不对"，而 DB3-01 那一类
 *      缺陷**与数据库无关**：它是"回源的 await 窗口里发生了作废"造成的旧值回写。
 *      这类时序只有把回源挂在一个手动 resolve 的 Promise 上才能稳定复现，
 *      用真库反而会因为查询太快而随机绿（典型的假绿灯）。
 */
import { describe, expect, it } from 'vitest';
import { withIdentityCache, type IdentityCheck, type IdentityRecord } from './identity.js';

function unblocked(): IdentityRecord {
  return { tokenVer: 1, blockedAt: null, isAdmin: false };
}
function blocked(): IdentityRecord {
  return { tokenVer: 1, blockedAt: new Date('2026-10-01T00:00:00Z'), isAdmin: false };
}

interface Stub {
  check: IdentityCheck;
  /** 回源次数（"下一次 load 必回源"这条承诺唯一可观测的证据）。 */
  calls: () => number;
  /** 释放第一次回源（用它模拟"查询很慢"）。 */
  release: (r: IdentityRecord) => void;
}

/**
 * 桩 `IdentityCheck`：第一次调用挂住，之后返回**当前**记录。
 * @param firstResult 第一次回源"读到"的值——竞态里它是**旧世界**的值。
 */
function stub(firstResult: IdentityRecord): Stub {
  let calls = 0;
  let current = firstResult;
  let release: ((r: IdentityRecord) => void) | undefined;
  const check: IdentityCheck = {
    async load(): Promise<IdentityRecord | null> {
      calls += 1;
      if (calls === 1) {
        return new Promise<IdentityRecord>((resolve) => {
          release = resolve;
        });
      }
      return current;
    },
  };
  return {
    check,
    calls: () => calls,
    release: (r) => {
      current = r; // 之后的回源看到"新世界"
      release?.(firstResult); // 但这一次读到的仍是旧值（它在事务提交前就读了）
    },
  };
}

describe('withIdentityCache：作废与在途回源的竞态（DB3-01）', () => {
  /**
   * 🔴 时序：请求 A 开始回源（读到"未封禁"）→ 管理员拉黑（提交 + `invalidate`）
   * → A 的查询结果到达。
   * @why F-06 / AJ-183 承诺的是"拉黑之后下一个请求就回源、就被拒"。
   *      只删缓存条目挡不住这一条：A 的结果在作废**之后**才回来，
   *      于是它把旧值又写了进去，"下一个请求"命中一份刚写的旧值、不再回源
   *      ⇒ 被拉黑者仍可放行最长 60 秒（窗口内还能改地址、读订单）。
   */
  it('🔴 回源期间作废过 → 旧值不进缓存，下一次 load 重新回源（DB3-01）', async () => {
    const s = stub(unblocked());
    const cached = withIdentityCache(s.check);

    const inflight = cached.load('u-1'); // 回源开始（此刻读到的是未封禁）
    expect(s.calls()).toBe(1);
    cached.invalidate('u-1'); // 拉黑事务已提交，路由调它作废
    s.release(blocked()); // 旧世界的结果现在才回来

    // 第一次返回旧值本身不算错——它读的时刻确实还没封禁
    await expect(inflight).resolves.toMatchObject({ blockedAt: null });

    // ⚠️ 关键：下一次 load 必须**重新回源**，且拿到已封禁
    const next = await cached.load('u-1');
    expect(next?.blockedAt).not.toBeNull();
    expect(s.calls()).toBe(2); // ← 修复前是 1：命中了被回写的旧值
  });

  it('没有作废时，回源结果照常进缓存（代际不能误伤正常路径）', async () => {
    const s = stub(unblocked());
    const cached = withIdentityCache(s.check);

    const first = cached.load('u-1');
    s.release(blocked());
    await first;
    const second = await cached.load('u-1');

    expect(s.calls()).toBe(1); // 第二次命中缓存
    expect(second?.blockedAt).toBeNull();
  });

  it('作废之后的下一次 load 一定回源（即使缓存里还有未过期的条目）', async () => {
    const s = stub(unblocked());
    const cached = withIdentityCache(s.check);
    const first = cached.load('u-1');
    s.release(blocked());
    await first;

    cached.invalidate('u-1');
    const after = await cached.load('u-1');
    expect(s.calls()).toBe(2);
    expect(after?.blockedAt).not.toBeNull();
  });
});
