/**
 * 职责：版本更新提示（剩余清单 4-9 / A39）——新版本下载好后问用户要不要立刻重启。
 *
 * @measured(developers.weixin.qq.com/miniprogram/dev/api/base/update/UpdateManager.html, 2026-10-06)：
 *   实例由 `wx.getUpdateManager()` 取得；方法 `applyUpdate()`（以新版本重启）、`onCheckForUpdate`、
 *   `onUpdateReady`（新版本下载好）、`onUpdateFailed`（下载失败）；基础库 ≥ 1.9.90。
 * @why 问一句而不是直接 `applyUpdate`：重启会丢掉当前页面（填了一半的地址、正在复制的支付链接）；
 *      用户点"稍后"也无妨——下一次冷启动自然用上新版本。
 * @why 下载失败静默：旧版本照常可用，弹窗只会让用户以为出了故障。
 * @limitation 只在冷启动时注册（app.js onLaunch）；热启动期间发布的新版本要等下次冷启动才提示。
 * @see ../app.js
 */

/**
 * @param {{getUpdateManager?: Function, showModal: Function}} api `createWxApi()` 的实例（测试注入假实现）
 * @returns {'watching'|'unsupported'}
 */
export function watchUpdate(api) {
  if (typeof api.getUpdateManager !== 'function') return 'unsupported';
  const mgr = api.getUpdateManager();
  if (mgr === undefined || mgr === null) return 'unsupported';
  mgr.onUpdateReady(() => {
    api.showModal({
      title: '发现新版本',
      content: '新版本已经准备好，是否现在重启使用？',
      confirmText: '重启',
      cancelText: '稍后',
      success: (r) => {
        if (r?.confirm === true) mgr.applyUpdate();
      },
    });
  });
  mgr.onUpdateFailed(() => undefined);
  return 'watching';
}
