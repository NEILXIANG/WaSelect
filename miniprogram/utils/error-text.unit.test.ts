/**
 * 职责：`utils/error-text.js` 的单测——错误形状的每种读法各有用例。
 *
 * @why 这些断言钉的都是"真机上只能靠截图排障"的场景：
 *      `code` 被吞掉 → 排障时只剩一句"加载失败"；`undefined` 被显示 → 用户以为站点坏了。
 *
 * @see ./error-text.js；../pages/home/index.vm.unit.test.ts（同组断言已随函数迁来此处）
 */
import { describe, expect, it } from 'vitest';
import { errorMessage } from './error-text.js';

describe('errorMessage', () => {
  it('带 code + message → `code message`（可机读，便于对照错误码表）', () => {
    expect(errorMessage({ code: 50003, message: '汇率缺失' })).toBe('50003 汇率缺失');
  });

  it('网络层负数码同样保留（-1 与业务码是两种故障，文案里不该混同）', () => {
    expect(errorMessage({ code: -1, message: '请求超时' })).toBe('-1 请求超时');
  });

  it('缺 message / message 是空白 → 兜底文案，不显示 undefined', () => {
    expect(errorMessage({ code: 40011 })).toBe('40011 加载失败');
    expect(errorMessage({ code: 40011, message: '   ' })).toBe('40011 加载失败');
  });

  it('Error 实例（没有 code）→ 只显示 message', () => {
    expect(errorMessage(new Error('网络不通'))).toBe('网络不通');
  });

  it('形状完全不对（undefined / 原始值 / null）→ 兜底文案，不抛', () => {
    for (const e of [undefined, null, 'x', 42]) {
      expect(errorMessage(e)).toBe('加载失败');
    }
  });
});
