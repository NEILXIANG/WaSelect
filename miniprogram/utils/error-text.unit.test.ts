/**
 * 职责：`utils/error-text.js` 的单测——错误形状的每种读法各有用例。
 *
 * @why 这些断言钉的都是"真机上只能靠截图排障"的场景：
 *      `code` 被吞掉 → 排障时只剩一句"加载失败"；`undefined` 被显示 → 用户以为站点坏了。
 *
 * @see ./error-text.js；../pages/home/index.vm.unit.test.ts（同组断言已随函数迁来此处）
 */
import { describe, expect, it } from 'vitest';
import { errorFields, errorMessage, errorRef } from './error-text.js';

describe('errorMessage', () => {
  // 剩余清单 4-6（M9）：错误分层——主文案只给人话，错误码与链路号挪到 errorRef 小字（原先 `code message` 拼在一行）
  it('🔴 带 code + message → 主文案只有 message（不再把码拼在前面）', () => {
    expect(errorMessage({ code: 50003, message: '汇率缺失' })).toBe('汇率缺失');
  });

  it('🔴 网络层失败（-1 / -2）→ 说人话（检查网络后重试），原始宿主串只进报障小字', () => {
    expect(errorMessage({ code: -1, message: 'request:fail timeout' })).toBe(
      '网络不太稳定，请检查网络后重试',
    );
  });

  it('缺 message / message 是空白 → 兜底文案，不显示 undefined', () => {
    expect(errorMessage({ code: 40011 })).toBe('加载失败');
    expect(errorMessage({ code: 40011, message: '   ' })).toBe('加载失败');
  });

  it('Error 实例（没有 code）→ 只显示 message', () => {
    expect(errorMessage(new Error('网络不通'))).toBe('网络不通');
  });

  it('形状完全不对（undefined / 原始值 / null）→ 兜底文案，不抛', () => {
    for (const e of [undefined, null, 'x', 42]) {
      expect(errorMessage(e)).toBe('加载失败');
    }
  });

  it('宿主 fail 的形状（只有 errMsg）→ 读 errMsg，不落到"加载失败"（B35 / AJ-218）', () => {
    // @why 宿主给的原因（如 navigateTo:fail webview count limit exceed）是排障时唯一的线索，
    //      在这一层被扔掉的话，页面上只剩四个字。
    expect(errorMessage({ errMsg: 'navigateTo:fail webview count limit exceed' })).toBe(
      'navigateTo:fail webview count limit exceed',
    );
  });

  it('message 优先于 errMsg（顺序固定，不是"谁新谁赢"）', () => {
    expect(errorMessage({ message: '业务说的原因', errMsg: '宿主说的原因' })).toBe('业务说的原因');
    // message 是空白时仍回落到 errMsg
    expect(errorMessage({ message: '  ', errMsg: '宿主说的原因' })).toBe('宿主说的原因');
  });

  it('errMsg 不是字符串 / 是空白 → 仍走兜底，不显示 [object Object]', () => {
    expect(errorMessage({ errMsg: 42 })).toBe('加载失败');
    expect(errorMessage({ errMsg: '   ' })).toBe('加载失败');
  });
});

describe('errorRef / errorFields（4-6）', () => {
  it('🔴 有码有链路 → `错误码 40002 · 链路 <前 8 位>`；只有码 → 只有码；什么都没有 → 空串（页面不显示小字）', () => {
    expect(errorRef({ code: 40002, message: 'x', traceId: 'abcdef1234567890' })).toBe(
      '错误码 40002 · 链路 abcdef12',
    );
    expect(errorRef({ code: 40002, message: 'x' })).toBe('错误码 40002');
    expect(errorRef(new Error('x'))).toBe('');
    expect(errorRef(null)).toBe('');
  });

  it('网络层失败 → 小字里带上宿主原始原因（排障唯一线索），主文案不带', () => {
    expect(errorRef({ code: -1, message: 'request:fail timeout', traceId: 't1' })).toBe(
      '错误码 -1 · 链路 t1 · request:fail timeout',
    );
  });

  it('errorFields：一次给出 {error, errorRef}；可换键名（saveError / saveErrorRef）', () => {
    const e = { code: 40002, message: '地址格式不对', traceId: 'abcdef1234' };
    expect(errorFields(e)).toEqual({
      error: '地址格式不对',
      errorRef: '错误码 40002 · 链路 abcdef12',
    });
    expect(errorFields(e, 'saveError')).toEqual({
      saveError: '地址格式不对',
      saveErrorRef: '错误码 40002 · 链路 abcdef12',
    });
  });
});

describe('网关错误（扫描 W-06）', () => {
  it('🔴 -3（有响应无业务码）→ 说"服务暂时不可用"，不说"检查网络"；小字带 HTTP 状态', () => {
    const e = { code: -3, message: '请求失败（HTTP 502）', traceId: 'abcdef1234' };
    expect(errorMessage(e)).toBe('服务暂时不可用，请稍后重试');
    expect(errorRef(e)).toBe('错误码 -3 · 链路 abcdef12 · 请求失败（HTTP 502）');
  });
});

describe('按码给出可执行的话（P2-40）', () => {
  it('50300 + retry_after_ms → "服务繁忙，约 N 秒后再试"（向上取整到秒）', () => {
    const e = {
      code: 50300,
      message: '服务暂时不可用，请稍后重试',
      data: { retry_after_ms: 12_300 },
    };
    expect(errorMessage(e)).toBe('服务繁忙，约 13 秒后再试');
  });

  it('50300 没带 / 带了坏的 retry_after_ms → 不编数字', () => {
    expect(errorMessage({ code: 50300, message: 'x' })).toBe('服务繁忙，请稍后再试');
    expect(errorMessage({ code: 50300, message: 'x', data: { retry_after_ms: -5 } })).toBe(
      '服务繁忙，请稍后再试',
    );
    expect(errorMessage({ code: 50300, message: 'x', data: { retry_after_ms: '3000' } })).toBe(
      '服务繁忙，请稍后再试',
    );
  });

  it('40301 → 账号被限制的说明（不是一句"无权限"）', () => {
    expect(errorMessage({ code: 40301, message: '无权限' })).toBe(
      '账号已被限制使用，如有疑问请联系客服',
    );
  });

  it('报障小字照旧带码（客服仍能对照）', () => {
    expect(errorRef({ code: 40301, message: '无权限', traceId: 'abcdef1234' })).toBe(
      '错误码 40301 · 链路 abcdef12',
    );
  });
});

describe('停售 40916（三端联动模拟 2026-10-08）', () => {
  it('说清"暂时不能付、到期自动关、不扣款、恢复后重下"，而不是一句"稍后再来"', () => {
    const t = errorMessage({ code: 40916, message: '店铺暂停接单，请稍后再来' });
    expect(t).toContain('暂停接单');
    expect(t).toContain('自动关闭');
    expect(t).toContain('不扣款');
  });
});
