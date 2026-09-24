/**
 * 职责：幂等执行器的 L0 单测——只覆盖**不需要数据库**的纯函数（指纹）。
 * 真库并发语义一律在 adapters/idempotency.db.test.ts，本文件不复制。
 *
 * @why 本文件跟着 `ports/idempotency.ts` 走而不是留在 adapters：指纹与作用域是**契约语义**，
 *      它们就在端口里（理由见 ports/idempotency.ts @limitation 二）。
 */
import { describe, expect, it } from 'vitest';
import { requestFingerprint } from './idempotency.js';

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
