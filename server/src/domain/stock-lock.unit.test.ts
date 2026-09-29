/**
 * 职责：`compareProductIdForLock`（建单第 6 步的取锁顺序）的**确定性**验证。
 *
 * @why 单独成一个 unit 文件而不是塞进 `create-order.db.test.ts`：它测的是纯函数，
 *      不需要 DB；放进 db 文件会让这条不变量每次都得等库起来，
 *      而"锁序必须与 locale 无关"是最重要的那条性质，不该被慢测试拖成没人跑。
 *
 * @why 这里**不断言** `localeCompare` 的行为（那依赖运行环境的 ICU 版本，
 *      换了构建就 flaky）。要证明的是我们自己的函数处处一致：
 *      ① 顺序等于 codePoint 序；② 输入排列不影响结果（全序）；
 *      ③ 大小写混合时与"字典序直觉"相反也没关系——锁序不需要好看。
 *
 * @limitation 测不出"两个实例真的用了同一个 locale"（那是环境问题，不是代码问题）；
 *             测的是"我们的排序根本不读 locale"，所以环境改不了它。
 *
 * @why 还要钉住 **SQL 侧**的排序也带 `collate "C"`（{@link PRODUCT_ID_LOCK_COLLATION}）：
 *      回补的排序发生在库里（`order by product_id`），用的是库的默认 collation；
 *      生产库默认什么 collation 至今没有 @measured。只钉 JS 侧而漏了 SQL 侧，
 *      "两边同一个序"就只有一半成立——而那一半恰恰是**关单批量**走的那一半。
 *
 * @see domain/stock-lock.ts；adapters/orders.ts（回补）；app/create-order.ts（第 6 步扣减）
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareProductIdForLock, PRODUCT_ID_LOCK_COLLATION } from './stock-lock.js';

describe('compareProductIdForLock（取锁顺序）', () => {
  it('顺序等于 codePoint 序：数字 < 大写 < 小写（不是任何语言的字典序）', () => {
    const ids = ['p-b', 'P-a', 'p-a', 'p-A', 'p-1'];
    expect([...ids].sort(compareProductIdForLock)).toEqual([
      'P-a', // 'P'(80) < 'p'(112)：大写整体在前
      'p-1', // '1'(49) < 'A'(65) < 'a'(97)
      'p-A',
      'p-a',
      'p-b',
    ]);
  });

  it('与 locale 直觉相反也照旧：小写 a **大于** 大写 B（codePoint 97 > 66）', () => {
    // @why 这正是不能换回 localeCompare 的原因：en collation 会给 'a' < 'B'，
    //      两边相反 = 两个实例若用不同排序，锁序就真的相反，死锁照旧发生。
    expect(compareProductIdForLock('a', 'B')).toBeGreaterThan(0);
  });

  it('全序且确定：输入怎么排列都得到同一把锁序（多实例才可能算出同一个顺序）', () => {
    const perms = [
      ['p-b', 'p-a', 'P-a'],
      ['p-a', 'P-a', 'p-b'],
      ['P-a', 'p-b', 'p-a'],
      ['p-a', 'p-b', 'P-a'],
    ];
    const results = perms.map((p) => [...p].sort(compareProductIdForLock).join(','));
    expect(new Set(results).size).toBe(1);
  });

  it('相等与自反：同 id 返回 0，反序返回相反符号（排序器要求的一致性）', () => {
    expect(compareProductIdForLock('p-a', 'p-a')).toBe(0);
    expect(compareProductIdForLock('p-a', 'p-b')).toBeLessThan(0);
    expect(compareProductIdForLock('p-b', 'p-a')).toBeGreaterThan(0);
  });
});

describe('SQL 侧的排序必须显式 collate（不依赖库的默认排序规则）', () => {
  it('PRODUCT_ID_LOCK_COLLATION 是 "C"（按字节/码点排，与 JS 的 < 同向）', () => {
    expect(PRODUCT_ID_LOCK_COLLATION).toBe('C');
  });

  it('回补的 SQL 里 order by product_id 带着这个 collation（剥注释后扫）', () => {
    // §2 第 54 条：先剥注释行——注释里也写着同样的字符串，不剥就会"只删用法、留下注释"也绿
    const src = readFileSync(new URL('../adapters/orders.ts', import.meta.url), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).toMatch(/order by product_id collate "\$\{PRODUCT_ID_LOCK_COLLATION\}"/);
  });
});
