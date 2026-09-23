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
import { describe, expect, it } from 'vitest';
import { createIntentIdempotency, newIdempotencyKey } from './idempotency.js';
import { ID_ALPHABET_CHARS, randomId } from './random-id.js';

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
