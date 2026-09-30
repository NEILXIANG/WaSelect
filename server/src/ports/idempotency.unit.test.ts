/**
 * 职责：幂等执行器的 L0 单测——只覆盖**不需要数据库**的纯函数（指纹）。
 * 真库并发语义一律在 adapters/idempotency.db.test.ts，本文件不复制。
 *
 * @why 本文件跟着 `ports/idempotency.ts` 走而不是留在 adapters：指纹与作用域是**契约语义**，
 *      它们就在端口里（理由见 ports/idempotency.ts @limitation 二）。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import {
  MAX_CLIENT_KEY_LENGTH,
  MAX_FINGERPRINT_DEPTH,
  requestFingerprint,
  scopeKey,
} from './idempotency.js';

/**
 * N16 定向：canonical() 的非常规输入形状。
 * @why 指纹是"客户端复用幂等键"（40908）的判定依据——null/数组/不可序列化值
 *      这些形状的归一化规则若不钉住，某次重构可能让"同一请求"算出两个指纹
 *      （正常重放被误判 40908）或反过来（不同请求同指纹，键复用抓不到）。
 */
describe('requestFingerprint 的非常规输入形状（N16 定向）', () => {
  it('null 与 undefined 归一为同一指纹（canonical 的 "null" 分支）', () => {
    expect(requestFingerprint(null)).toBe(requestFingerprint(undefined));
  });

  it('数组参与指纹且**顺序敏感**（[1,2] 与 [2,1] 是不同的请求）', () => {
    expect(requestFingerprint([1, 2])).not.toBe(requestFingerprint([2, 1]));
    expect(requestFingerprint({ list: [1, 2] })).toBe(requestFingerprint({ list: [1, 2] }));
  });

  it('不可序列化值（function/symbol）归一为 "null"，不抛错', () => {
    // JSON.stringify(function/symbol) = undefined——canonical 必须兜住，
    // 否则 requestFingerprint({ cb }) 会直接抛在请求路径上
    expect(requestFingerprint(() => 1)).toBe(requestFingerprint(null));
    expect(requestFingerprint({ cb: () => 1 })).toBe(requestFingerprint({ cb: null }));
    expect(requestFingerprint(Symbol('s'))).toBe(requestFingerprint(null));
  });
});

/**
 * scopeKey 的客户端键限长（I1-U7b / 地基清单欠账⑧：`key TEXT` 无上限 = 存储型 DoS）。
 * @why 校验收口在 scopeKey：所有走幂等的写路由都经它拼键，别无第二处"128"。
 */
describe('scopeKey：客户端幂等键 ≤128（存储型 DoS 防线）', () => {
  it('恰好 128 → 通过；键形状保持 `user:route:clientKey` 不变', () => {
    const key = 'k'.repeat(MAX_CLIENT_KEY_LENGTH);
    expect(scopeKey({ userId: 'u-1', route: 'orders.create', clientKey: key })).toBe(
      `u-1:orders.create:${key}`,
    );
  });

  it('匿名作用域（无 userId）也不受影响', () => {
    expect(scopeKey({ route: 'r', clientKey: 'x' })).toBe('anon:r:x');
  });

  it('129 → 40001 idempotency_key_too_long（超限不是"截断后继续"，是响亮拒绝）', () => {
    // @why 不截断：截断会把两个不同的长键折叠成同一个 → 后一单被当成重放，
    //      表现是"用户下了两单只建了一单"——静默且丢钱，比报错贵得多
    let caught: unknown;
    try {
      scopeKey({ userId: 'u-1', route: 'orders.create', clientKey: 'k'.repeat(129) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      code: 40001,
      details: { reason: 'idempotency_key_too_long' },
    });
  });

  it('几 MB 的"键"在同一条防线被拦（DoS 形态的极端值，不是边界值）', () => {
    let caught: unknown;
    try {
      scopeKey({ route: 'r', clientKey: 'k'.repeat(1_000_000) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 40001 });
  });
});

/**
 * AJ-235（第二轮审查 INF2-03）：指纹素材的**嵌套深度**必须有上限。
 * @why `canonical()` 是递归的。登录用户发一个嵌套几千层的请求体（几 KB 就够），
 *      递归把栈打穿 → `RangeError` → 50000 + `unhandled_error` 日志——
 *      一个稳定可重复的"用小请求打出 500"的入口（建单与发起支付都把未裁剪的 body 交给指纹）。
 */
describe('requestFingerprint：嵌套深度上限（AJ-235）', () => {
  const nested = (depth: number): unknown => {
    let v: unknown = 1;
    for (let i = 0; i < depth; i += 1) v = { a: v };
    return v;
  };

  it('🔴 超过上限 → AppError 40001（不是 RangeError / 50000）', () => {
    let thrown: unknown;
    try {
      requestFingerprint(nested(MAX_FINGERPRINT_DEPTH + 1));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe(40001);
    expect((thrown as AppError).details).toMatchObject({ reason: 'request_too_deep' });
  });

  it('🔴 几千层（足以打穿递归栈的量级）→ 同样是 40001，而不是栈溢出', () => {
    expect(() => requestFingerprint(nested(5_000))).toThrow(AppError);
  });

  it('恰好等于上限 → 正常出指纹；数组嵌套同样计入深度', () => {
    expect(requestFingerprint(nested(MAX_FINGERPRINT_DEPTH))).toMatch(/^[0-9a-f]{64}$/);
    let arr: unknown = 1;
    for (let i = 0; i < MAX_FINGERPRINT_DEPTH + 1; i += 1) arr = [arr];
    expect(() => requestFingerprint(arr)).toThrow(AppError);
  });

  it('真实请求体的深度远在上限之内（建单体：items 数组里的对象 = 3 层）', () => {
    const body = { items: [{ product_id: 'p-1', qty: 2 }], address_id: 'a-1', terms_version: 'T' };
    expect(requestFingerprint(body)).toMatch(/^[0-9a-f]{64}$/);
    expect(MAX_FINGERPRINT_DEPTH).toBeGreaterThanOrEqual(8);
  });
});
