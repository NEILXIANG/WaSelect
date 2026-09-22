/**
 * 职责：错误与响应规范的 L0 单测（F4）。
 * 重点不是"能构造错误"，而是**响应体不泄漏内部细节**——这条一旦破防就是安全事故，所以逐条断言。
 * @see docs/地基搭建清单.md F4；docs/代码注释规范与日志体系设计.md（脱敏红线）
 */
import { describe, expect, it } from 'vitest';
import { AppError, asErrorCode, errorLogFields, toErrorResponse } from './errors.js';

describe('AppError', () => {
  it('已知码带出注册表的文案与 HTTP 状态（码前三位）', () => {
    const e = new AppError(40011);
    expect(e.code).toBe(40011);
    expect(e.httpStatus).toBe(400);
    expect(e.message).toBe('条款版本缺失或已过期');
    expect(e).toBeInstanceOf(Error);
  });

  it('登记码的 HTTP 状态与业务码一致，不做二次映射表', () => {
    expect(new AppError(40907).httpStatus).toBe(409);
    expect(new AppError(50002).httpStatus).toBe(500);
    expect(new AppError(42901).httpStatus).toBe(429);
  });
});

describe('toErrorResponse', () => {
  it('AppError 原样输出码与文案', () => {
    const { status, body } = toErrorResponse(new AppError(40901));
    expect(status).toBe(409);
    expect(body).toEqual({ code: 40901, message: '库存不足' });
  });

  it('未知异常折叠为 500 + 50000，且不回传原始 message', () => {
    const err = new Error('connection to 10.0.0.7:5432 refused, password=xxx');
    const { status, body } = toErrorResponse(err);
    expect(status).toBe(500);
    expect(body.code).toBe(50000);
    expect(body.message).toBe('服务器内部错误');
    expect(JSON.stringify(body)).not.toContain('password');
    expect(JSON.stringify(body)).not.toContain('10.0.0.7');
  });

  it('非 Error 的 throw（字符串 / undefined / 对象）同样安全折叠', () => {
    for (const thrown of ['boom', undefined, null, { a: 1 }, 42]) {
      const { status, body } = toErrorResponse(thrown);
      expect(status).toBe(500);
      expect(body.code).toBe(50000);
    }
  });

  it('响应体绝不含 details / stack 字段', () => {
    const { body } = toErrorResponse(
      new AppError(50001, { sql: 'select * from users', trace: 't-1' }),
    );
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);
    expect(JSON.stringify(body)).not.toContain('select * from users');
  });
});

describe('errorLogFields（只进日志，可含细节）', () => {
  it('AppError 带出码与 details，供日志定位', () => {
    const f = errorLogFields(new AppError(50001, { provider: 'stripe', reason: 'card_declined' }));
    expect(f.err_code).toBe(50001);
    expect(f.details).toEqual({ provider: 'stripe', reason: 'card_declined' });
  });

  it('未知异常带出 name / message / stack', () => {
    const f = errorLogFields(new Error('boom'));
    expect(f.err_type).toBe('Error');
    expect(f.err_message).toBe('boom');
    expect(typeof f.err_stack).toBe('string');
  });
});

describe('asErrorCode（外部数字收敛）', () => {
  it('已登记返回原码，未登记返回 undefined', () => {
    expect(asErrorCode(40903)).toBe(40903);
    expect(asErrorCode(49999)).toBeUndefined();
  });
});
