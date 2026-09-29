/**
 * 职责：`app/admin-audit.ts` 的纯函数单测——审计 after 的**脱敏**（F-02 / AJ-183）。
 *
 * @why admin_audit 没有保留期（append-only、永久）：PII 一旦原样落进去就再也删不掉（触发器拒 UPDATE/DELETE）。
 *      约束七的红线（地址、电话、邮箱、口令）在这里按键名兜住，嵌套与数组都要兜到。
 */
import { describe, expect, it } from 'vitest';
import { auditPayload, PII_KEYS } from './admin-audit.js';

describe('auditPayload（审计 after 脱敏）', () => {
  it('改址请求体：收件人 / 电话 / 街道 → [redacted]，州 / 邮编 / 国家保留（排查够用、不落 PII）', () => {
    expect(
      auditPayload({
        recipient: 'Jane Doe',
        phone: '+14155550123',
        line1: '1 Infinite Loop',
        line2: 'Apt 2',
        city: 'Cupertino',
        state: 'CA',
        postal_code: '95014',
        country: 'US',
      }),
    ).toEqual({
      recipient: '[redacted]',
      phone: '[redacted]',
      line1: '[redacted]',
      line2: '[redacted]',
      city: 'Cupertino',
      state: 'CA',
      postal_code: '95014',
      country: 'US',
    });
  });

  it('嵌套对象与数组也脱敏；口令 / 邮箱在任何层级都不落库', () => {
    expect(
      auditPayload([{ carrier: 'EMS', meta: { email: 'a@b.c', password: 'x'.repeat(12) } }]),
    ).toEqual([{ carrier: 'EMS', meta: { email: '[redacted]', password: '[redacted]' } }]);
  });

  it('非对象（undefined / 字符串 / Buffer 之外的 multipart 空体）→ null', () => {
    expect(auditPayload(undefined)).toBeNull();
    expect(auditPayload('raw')).toBeNull();
    expect(auditPayload(null)).toBeNull();
  });

  it('PII 键名清单至少覆盖约束七的四类（地址、电话、邮箱、口令）', () => {
    for (const k of ['recipient', 'line1', 'phone', 'email', 'contact_email', 'password']) {
      expect(PII_KEYS.has(k), k).toBe(true);
    }
  });
});
