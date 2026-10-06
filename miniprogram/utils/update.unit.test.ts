/**
 * 职责：版本更新提示（剩余清单 4-9 / A39）。
 * @measured(developers.weixin.qq.com/miniprogram/dev/api/base/update/UpdateManager.html, 2026-10-06)：见 ./update.js 文件头。
 */
import { describe, expect, it } from 'vitest';
import { watchUpdate } from './update.js';

function fakeHost(confirm: boolean) {
  const calls: string[] = [];
  let ready: (() => void) | undefined;
  let failed: (() => void) | undefined;
  return {
    calls,
    fireReady: () => ready?.(),
    fireFailed: () => failed?.(),
    api: {
      getUpdateManager: () => ({
        onUpdateReady: (cb: () => void) => {
          ready = cb;
        },
        onUpdateFailed: (cb: () => void) => {
          failed = cb;
        },
        applyUpdate: () => calls.push('applyUpdate'),
      }),
      showModal: (o: {
        title: string;
        content: string;
        success?: (r: { confirm: boolean }) => void;
      }) => {
        calls.push(`modal:${o.title}`);
        o.success?.({ confirm });
      },
    },
  };
}

describe('watchUpdate（4-9）', () => {
  it('🔴 新版本下载好 → 弹窗问是否重启；用户确认 → applyUpdate', () => {
    const h = fakeHost(true);
    expect(watchUpdate(h.api)).toBe('watching');
    expect(h.calls).toEqual([]); // 没下载好之前不打扰
    h.fireReady();
    expect(h.calls).toEqual(['modal:发现新版本', 'applyUpdate']);
  });

  it('用户点"稍后" → 不重启（下次冷启动自然用上新版本）', () => {
    const h = fakeHost(false);
    watchUpdate(h.api);
    h.fireReady();
    expect(h.calls).toEqual(['modal:发现新版本']);
  });

  it('下载失败 → 静默（不弹窗打扰，旧版本照常可用）；宿主没有 getUpdateManager → unsupported', () => {
    const h = fakeHost(true);
    watchUpdate(h.api);
    h.fireFailed();
    expect(h.calls).toEqual([]);
    expect(watchUpdate({ showModal: () => undefined })).toBe('unsupported');
  });
});
