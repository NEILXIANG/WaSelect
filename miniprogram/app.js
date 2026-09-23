/**
 * 职责：小程序入口（F6c 壳）——持有全局 token 与唯一的请求实例。
 *
 * @why 请求实例只建一个：trace_id 生成、token 注入、埋点出口都挂在它身上，
 *      若每个页面各建一个，就会出现"这个页面的日志没有 trace_id"这类只在一处发生的缺失。
 *
 * @see docs/地基搭建清单.md F6c（小程序壳）；docs/代码注释规范与日志体系设计.md（trace_id 与用户行为流 C）
 * @limitation 骨架期**没有登录页**：token 需要手动粘贴（见 pages/index）。
 *              真实流程是 `wx.login` → 服务端 code2session 换 openid → 签发 token，
 *              属 F6b 的业务部分（骨架里 F6b 只提供了签发/校验能力，不含登录业务）。
 *              这不是待办遗漏，是刻意把"登录业务"留到业务期，避免骨架里长出半成品逻辑。
 */
import { createRequester } from './utils/request.js';
import { API_BASE } from './config.js';

App({
  globalData: {
    token: '',
    apiBase: API_BASE,
    /** 唯一的请求实例；页面通过 `getApp().globalData.api` 使用。 */
    api: null,
    /** 最近一次链路 ID，用于真机排障时对照服务端日志。 */
    lastTraceId: '',
  },

  onLaunch() {
    this.globalData.token = wx.getStorageSync('token') || '';
    this.globalData.api = createRequester({
      getToken: () => this.globalData.token,
      log: (fields) => {
        if (fields.trace_id) this.globalData.lastTraceId = fields.trace_id;
        // 骨架期只用实时日志：ADR-29 的 /beacon 落库上报待 F5 补完
        wx.getRealtimeLogManager?.()?.info?.(fields.event ?? 'api', JSON.stringify(fields));
      },
    });
  },

  /** 写入 token（骨架期由页面手动粘贴；真实流程由登录回调调用）。 */
  setToken(token) {
    this.globalData.token = token;
    wx.setStorageSync('token', token);
  },
});
