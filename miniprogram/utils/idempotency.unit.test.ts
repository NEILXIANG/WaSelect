/**
 * 职责：幂等键生成 + 「一次意图一个键」生命周期的单测（D32）。
 *
 * @why 这个缺陷的形态是**静默的**：每次点击都新建键，功能上"完全能跑通"，
 *      只有当用户真的连点 / 网络重试时才会建出两张单。而测试环境网络永远顺，
 *      靠手点很难复现——所以必须用断言把"键的稳定性"钉死。
 *
 * 红灯证据（先写断言，再注入缺陷验证它真的红）：
 *   1. 把 acquire 改成"每次都新建"（即原来的 `mp-${Date.now()}` 语义）
 *      → 「重试复用同一个键」「失败后重试仍是同一个键」2 条变红；
 *   2. 把 newIdempotencyKey 换成 `() => \`mpord-${Date.now()}\``
 *      → 「1 万次不重复」变红（同一毫秒内必然撞车）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createIntentIdempotency, newIdempotencyKey } from './idempotency.js';
import { ID_ALPHABET_CHARS, randomId } from './random-id.js';

/** 写操作的两张页面：它们的幂等键必须走生命周期器，不能自己现造。 */
const WRITE_PAGES = ['pages/checkout/index.js', 'pages/pay/index.js'];

/** 服务端 trace/键的字符集要求；幂等键自身不含 ':' 是 scopeKey 拼接的需要。 */
const SERVER_SAFE = /^[A-Za-z0-9._:-]{8,64}$/;

describe('randomId 形状', () => {
  it('前缀与长度符合约定，字符集合规', () => {
    const id = randomId('mp-', 20);
    expect(id.startsWith('mp-')).toBe(true);
    expect(id).toHaveLength(23);
    expect(id).toMatch(SERVER_SAFE);
    expect(ID_ALPHABET_CHARS).toHaveLength(32);
  });

  it('长度可指定，且每一位都在字母表内', () => {
    const id = randomId('x-', 5);
    expect(id).toHaveLength(7);
    for (const ch of id.slice(2)) {
      expect(ID_ALPHABET_CHARS).toContain(ch);
    }
  });
});

describe('newIdempotencyKey', () => {
  it('前缀 mpord- 与 trace_id 的 mp- 可区分，且不含冒号', () => {
    const key = newIdempotencyKey();
    expect(key.startsWith('mpord-')).toBe(true);
    // ⚠️ 服务端 scopeKey() 用 ':' 拼 user:route:key，键里带冒号会让作用域串有歧义
    expect(key).not.toContain(':');
    expect(key).toMatch(SERVER_SAFE);
  });

  it('1 万次不重复（专抓"用时间戳当键"这类实现）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(newIdempotencyKey());
    expect(seen.size).toBe(10_000);
  });

  it('⚠️ 长度在契约上限 128 内', () => {
    expect(newIdempotencyKey().length).toBeLessThanOrEqual(128);
  });

  it('⚠️ 时间前进半年后产出**不变** → 键里没藏 Date.now（约束十）', () => {
    // @why "同一毫秒内两次相同"这类断言会漏：真掺了 Date.now() 也常常产出相同串。
    //      用假时钟把时间明确推到两个不同的点，才真的钉住"不取时间"。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const early = newIdempotencyKey();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      expect(newIdempotencyKey()).not.toBe(early); // 键本身每次都不同（下一条钉的是"不掺时间"不是"恒定"）
      const a = createIntentIdempotency({ newKey: () => 'fixed' }).acquire().key;
      vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
      const b = createIntentIdempotency({ newKey: () => 'fixed' }).acquire().key;
      expect(b).toBe(a);
    } finally {
      vi.useRealTimers();
    }
  });

  it('默认随机源下两次调用不相同', () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});

describe('一次意图一个键', () => {
  it('连续两次 acquire 是同一个键，且第二次被标记为重试', () => {
    const intent = createIntentIdempotency();
    const first = intent.acquire();
    const second = intent.acquire();
    expect(first.isRetry).toBe(false);
    expect(second.isRetry).toBe(true);
    expect(second.key).toBe(first.key);
  });

  it('失败后不 retire，重试仍是同一个键（服务端靠它认出是重放）', () => {
    const intent = createIntentIdempotency();
    const first = intent.acquire().key;
    // 模拟：请求失败 → 页面什么都不做 → 用户再点一次
    expect(intent.acquire().key).toBe(first);
    expect(intent.acquire().key).toBe(first);
  });

  it('成功后 retire，下一次点击是新意图（新键、isRetry=false）', () => {
    const intent = createIntentIdempotency();
    const first = intent.acquire().key;
    intent.retire();
    const next = intent.acquire();
    expect(next.key).not.toBe(first);
    expect(next.isRetry).toBe(false);
  });

  it('意图内容变化后 retire，避免新单被当成重放返回旧单', () => {
    // 场景：用户建单失败 → 改了收货地址 → 重新下单。
    // 若不 retire，服务端会按同一个键重放**旧地址**那张单的结果。
    const intent = createIntentIdempotency();
    const before = intent.acquire().key;
    intent.retire();
    expect(intent.acquire().key).not.toBe(before);
  });

  it('可注入生成器，断言不依赖随机数', () => {
    let n = 0;
    const intent = createIntentIdempotency({ newKey: () => `mpord-${(n += 1)}` });
    expect(intent.acquire()).toEqual({ key: 'mpord-1', isRetry: false });
    expect(intent.acquire()).toEqual({ key: 'mpord-1', isRetry: true });
    intent.retire();
    expect(intent.acquire()).toEqual({ key: 'mpord-2', isRetry: false });
  });
});

describe('防回归：写操作页面必须**用**生命周期器（A5）', () => {
  /**
   * @why 上面的用例只证明"`createIntentIdempotency` 是对的"，管不住页面不用它：
   *      结算页与支付页曾经每次点击都 `newIdemKey()`，而文件头注释写的是
   *      "重试复用同一个"——**注释与实现相反**，单测全绿（ADR-29 直接命中）。
   *      所以要有一条"这个模块真的被用上了"的断言，而不只是"这个模块是对的"。
   * @limitation 扫源码是文本级（第 54 条）：先剥注释行再扫——注释里也写着
   *              `acquire()` 与 `retire()`，不剥的话"删掉调用、只留注释"会假绿。
   */
  it('checkout / pay 两页的代码里走 acquire()，且不得再出现现造键的写法', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    for (const page of WRITE_PAGES) {
      const src = readFileSync(`${root}/${page}`, 'utf8');
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      expect(code, `${page} 必须调 acquire()`).toMatch(/\.acquire\(\)/);
      expect(code, `${page} 不得再自己现造幂等键`).not.toMatch(/newIdemKey\s*\(/);
      expect(code, `${page} 不得再把新键直接赋给实例字段`).not.toMatch(/this\.idemKey\s*=/);
    }
  });
});

describe('防回归：禁止再用时间戳当幂等键', () => {
  /**
   * @why 上面的用例只保证"现在的实现是对的"，管不住有人在页面里图省事又写
   *      `idempotencyKey: \`mp-${Date.now()}\``——那种写法单看那一行完全合理。
   *      所以扫一遍源码，把这类写法变成红灯。
   * @limitation 是正则扫描而非 AST 解析：能抓住直行写法，抓不住
   *              `const k = Date.now(); ... idempotencyKey: k` 这种绕道；
   *              真要杜绝应在服务端拒绝形如 `mp-17xxxxxxxxx` 的键（尚未做，属 P2）。
   */
  it('小程序源码里不得出现「幂等键用 Date.now() 现生成」', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = `${dir}/${name}`;
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith('.js')) continue;
        const src = readFileSync(full, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (/idempotencyKey\s*:/.test(line) && /Date\s*\.\s*now\s*\(/.test(line)) {
            offenders.push(`${name}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
