/**
 * 职责：隐私授权前置（剩余清单 4-3 / A36）。
 * @measured(developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html, 2026-10-06)：
 *   2023-10-17 起隐私相关功能默认启用（不再需要 __usePrivacyCheck__）；未注册 onNeedPrivacyAuthorization 时
 *   由微信弹官方授权弹窗；`wx.getPrivacySetting` 返回 needAuthorization / privacyContractName；
 *   `wx.requirePrivacyAuthorize` "用于模拟隐私接口调用"以触发授权流程。
 */
import { describe, expect, it } from 'vitest';
import { copyFailText, ensurePrivacyAuthorized } from './privacy.js';

type Cb = { success?: (r?: unknown) => void; fail?: (e?: unknown) => void };

function fakeWx(opts: {
  need?: boolean;
  agree?: boolean;
  noApi?: boolean;
  settingFails?: boolean;
}) {
  const calls: string[] = [];
  if (opts.noApi === true) return { calls, api: {} };
  return {
    calls,
    api: {
      getPrivacySetting: (o: Cb) => {
        calls.push('getPrivacySetting');
        if (opts.settingFails === true) o.fail?.({ errMsg: 'x' });
        else
          o.success?.({
            needAuthorization: opts.need === true,
            privacyContractName: '《WaSelect 隐私保护指引》',
          });
      },
      requirePrivacyAuthorize: (o: Cb) => {
        calls.push('requirePrivacyAuthorize');
        if (opts.agree === true) o.success?.();
        else o.fail?.({ errMsg: 'requirePrivacyAuthorize:fail auth deny' });
      },
    },
  };
}

describe('ensurePrivacyAuthorized（4-3）', () => {
  it('🔴 需要授权 → 主动触发官方弹窗；用户同意 → agreed', async () => {
    const w = fakeWx({ need: true, agree: true });
    expect(await ensurePrivacyAuthorized(w.api)).toBe('agreed');
    expect(w.calls).toEqual(['getPrivacySetting', 'requirePrivacyAuthorize']);
  });

  it('🔴 用户拒绝 → denied（不抛：启动流程不能因此中断）', async () => {
    expect(await ensurePrivacyAuthorized(fakeWx({ need: true, agree: false }).api)).toBe('denied');
  });

  it('已授权过 → not_needed，且**不**再弹窗', async () => {
    const w = fakeWx({ need: false });
    expect(await ensurePrivacyAuthorized(w.api)).toBe('not_needed');
    expect(w.calls).toEqual(['getPrivacySetting']);
  });

  it('基础库过低（没有这两个 API）或查询失败 → unsupported（交给微信在调用隐私接口时自行弹窗）', async () => {
    expect(await ensurePrivacyAuthorized(fakeWx({ noApi: true }).api)).toBe('unsupported');
    expect(await ensurePrivacyAuthorized(fakeWx({ settingFails: true }).api)).toBe('unsupported');
  });
});

describe('copyFailText', () => {
  const FALLBACK = '复制失败，请长按下方链接手动复制';
  it('🔴 拒绝过隐私授权 → 说清原因（隐私保护指引）并保留兜底动作；其余 → 页面自己的兜底文案', () => {
    expect(copyFailText('denied', FALLBACK)).toContain('隐私保护指引');
    expect(copyFailText('denied', FALLBACK)).toContain('长按');
    expect(copyFailText('agreed', FALLBACK)).toBe(FALLBACK);
    expect(copyFailText(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
