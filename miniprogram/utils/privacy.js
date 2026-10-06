/**
 * 职责：隐私授权前置（剩余清单 4-3 / A36）——启动时若需要授权，主动调起微信官方授权弹窗。
 *
 * @measured(developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html, 2026-10-06)：
 *   2023-10-17 起隐私相关功能默认启用；未注册 `wx.onNeedPrivacyAuthorization` 时，调用隐私接口会由微信弹**官方**授权弹窗；
 *   `wx.getPrivacySetting` 返回 `needAuthorization` / `privacyContractName`；`wx.requirePrivacyAuthorize` 用于主动触发该流程。
 * @why 主动前置而不是等用户走到隐私接口：本小程序最要紧的隐私接口是**复制支付链接**（setClipboardData，D-49 银行卡唯一路径）。
 *      等到那一刻才弹窗，用户正在付款、一个"拒绝"就让复制失败，而他不知道为什么；
 *      启动时先问清楚，后面的失败文案也能说出原因（copyFailText）。
 * @why 用官方弹窗、不自绘：自绘要写一个带 `open-type="agreePrivacyAuthorization"` 的组件并注册监听，
 *      还要处理"监听注册了却没 resolve"的卡死；官方弹窗是微信维护的、审核口径一致。
 * @why 拒绝**不抛**：启动流程不能因为用户拒绝隐私授权就中断（浏览商品不需要隐私接口）。
 * @limitation 一：只问一次（每次冷启动）。用户拒绝后，微信对"10 秒内连续拒绝"不再弹窗，这里也不重试。
 * @limitation 二：隐私指引的内容在公众平台填写（需 AppID）——漏声明剪贴板会让所有用户复制失败（errno 112），
 *              那是配置问题，代码兜不住，只能靠文案让用户长按手动复制。
 * @see ../app.js（启动时调用）；../pages/pay/index.vm.js（copyResult）
 */

/**
 * @param {{getPrivacySetting?: Function, requirePrivacyAuthorize?: Function}} api `createWxApi()` 的实例（测试注入假实现）
 * @returns {Promise<'not_needed'|'agreed'|'denied'|'unsupported'>}
 */
export function ensurePrivacyAuthorized(api) {
  return new Promise((resolve) => {
    if (
      typeof api.getPrivacySetting !== 'function' ||
      typeof api.requirePrivacyAuthorize !== 'function'
    ) {
      resolve('unsupported');
      return;
    }
    api.getPrivacySetting({
      success: (r) => {
        if (r?.needAuthorization !== true) {
          resolve('not_needed');
          return;
        }
        api.requirePrivacyAuthorize({
          success: () => resolve('agreed'),
          fail: () => resolve('denied'),
        });
      },
      fail: () => resolve('unsupported'),
    });
  });
}

/**
 * 复制失败时的文案：拒绝过隐私授权就说清原因，否则用页面自己的兜底文案。
 * @param {unknown} privacy `app.globalData.privacy`（ensurePrivacyAuthorized 的结果）
 * @param {string} fallback 页面原有的"长按手动复制"文案
 */
export function copyFailText(privacy, fallback) {
  if (privacy === 'denied') {
    return '你还没有同意隐私保护指引，复制被微信拦下了：请长按链接手动复制，或重新打开小程序后同意';
  }
  return fallback;
}
