/**
 * 职责：调度器适配器的 L0 单测——**只验锁 ID 的推导**（纯函数，不需要数据库）。
 *
 * @why 锁 ID 的推导有一条很容易被忽略的硬要求：**两个进程必须对同一个名字算出同一个数**。
 *      这条一旦破（比如改成"按进程启动时分配递增 ID"、或用了不确定的哈希种子），
 *      两个实例就各锁各的——互斥在单机测试里**完全看不出来**（只有一个进程，永远拿得到锁），
 *      只在真扩容那天失效，而那天的症状是"定时任务跑了两次"，没人会想到是锁 ID 算错了。
 *      所以这里用**独立算出的**参考向量钉死它：算法换了就会红。
 *
 * @how 参考值是另写一段 FNV-1a 算出来的（不是从实现里抄的），见各用例里的 `@measured`。
 *      真库的互斥与心跳语义不在这里——见 `scheduler.db.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { advisoryLockKey, LOCK_NAMESPACE } from './scheduler.js';
import { TICK_LOCK_KEY } from '../ports/scheduler.js';

describe('advisoryLockKey：名字 → 两个 int4', () => {
  it('同名必然同键（**跨进程**一致：互斥的全部前提）', () => {
    expect(advisoryLockKey('scheduler:tick')).toEqual(advisoryLockKey('scheduler:tick'));
  });

  it('不同名必然不同键（同一命名空间内不撞车）', () => {
    expect(advisoryLockKey('scheduler:tick').key).not.toBe(advisoryLockKey('scheduler:daily').key);
  });

  it(
    '已知向量：`scheduler:tick` → -1172024131（算法换了就红——' +
      '换算法会让**升级期间新老实例各锁各的**，互斥当场失效）',
    () => {
      // @measured: 独立实现 FNV-1a（offset basis 0x811c9dc5 / prime 0x01000193）算得
      //   'scheduler:tick'  → -1172024131
      //   'scheduler:daily' → -1498232223
      expect(advisoryLockKey(TICK_LOCK_KEY).key).toBe(-1172024131);
      expect(advisoryLockKey('scheduler:daily').key).toBe(-1498232223);
    },
  );

  it('空串也能算出键（FNV 的 offset basis，不抛错）', () => {
    // @measured: 0x811c9dc5 | 0 === -2128831035
    expect(advisoryLockKey('').key).toBe(-2128831035);
  });

  it('两个分量都落在 **int4 有符号范围**内（超出会被 PG 报 22003 numeric_value_out_of_range）', () => {
    for (const name of ['', 'scheduler:tick', 'scheduler:daily', 'x'.repeat(500)]) {
      const { namespace, key } = advisoryLockKey(name);
      for (const v of [namespace, key]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(-2_147_483_648);
        expect(v).toBeLessThanOrEqual(2_147_483_647);
      }
    }
  });

  it('命名空间是固定常量（不与其它用途的 advisory lock 撞键）', () => {
    expect(advisoryLockKey('a').namespace).toBe(LOCK_NAMESPACE);
    expect(advisoryLockKey('b').namespace).toBe(LOCK_NAMESPACE);
  });
});
