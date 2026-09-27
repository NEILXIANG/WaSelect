/**
 * 职责：小程序入口（F6c 壳）——持有全局 token 与唯一的请求实例。
 *
 * @why 请求实例只建一个：trace_id 生成、token 注入、埋点出口都挂在它身上，
 *      若每个页面各建一个，就会出现"这个页面的日志没有 trace_id"这类只在一处发生的缺失。
 *
 * @see docs/地基搭建清单.md F6c（小程序壳）；docs/代码注释规范与日志体系设计.md（trace_id 与用户行为流 C）
 * @limitation 当前**没有登录页**（I2 落地）：token 需要手动粘贴（见 pages/index）。
 *              真实流程是 `wx.login` → 服务端 code2session 换 openid → 签发 token，
 *              属 F6b 的业务部分（骨架里 F6b 只提供了签发/校验能力，不含登录业务）。
 *              这不是待办遗漏，是刻意把"登录业务"留到业务期，避免骨架里长出半成品逻辑。
 * @limitation 二：token 的本地键在 `ws:` 前缀下（走 `utils/storage.js`），
 *              与本项目早期那版裸 `token` 键**不兼容**——升级后需要重新粘贴一次 token。
 *              ⚠️ 刻意**不做自动迁移**：当前没有真实用户（骨架期 token 是手填的），
 *              为一次性重填写迁移代码，换来的是一段没人测过的"读旧写新删旧"逻辑，
 *              而它出错的形态恰好是"把用户的 token 删了"。真上线前若已有用户，再单独立单元做。
 */
import { createRequester } from './utils/request.js';
import { createWxApi } from './utils/wx-api.js';
import { createStorage } from './utils/storage.js';
import { API_BASE } from './config.js';

/**
 * token 在本地存储里的键。
 * @why 读写都在本文件的相邻两处，仍然抽成常量：键名漂移是"改了写、没改读"这类错误的典型形态，
 *      而它不报错——表现为"每次重登都成功，但一进 App 又是未登录"。
 */
const TOKEN_KEY = 'token';

App({
  globalData: {
    token: '',
    apiBase: API_BASE,
    /** 唯一的请求实例；页面通过 `getApp().globalData.api` 使用。 */
    api: null,
    /** 唯一的本地存储实例（带 `ws:` 前缀）；页面不要用宿主的 `getStorageSync`。 */
    storage: null,
    /** 最近一次链路 ID，用于真机排障时对照服务端日志。 */
    lastTraceId: '',
  },

  onLaunch() {
    // ⚠️ 宿主能力**只在这里取一次**，然后往下传：app 是装配层，
    //    它知道"跑在小程序里"这件事，下面的 request / 页面不该再关心。
    const wxApi = createWxApi();
    // ⚠️ 本地存储一律走 `storage` 封装，**不要用 wxApi.getStorageSync**：
    //    那条路没有 `ws:` 前缀，会与同 appid 内任何第三方 SDK 的同名键互撞，
    //    而且互撞**不报错**（只是数据突然不对）。前缀规则由 `storage.js` 唯一持有。
    const storage = createStorage({ wx: wxApi });
    this.globalData.storage = storage;
    this.globalData.token = storage.getString(TOKEN_KEY);
    this.globalData.api = createRequester({
      wx: wxApi,
      getToken: () => this.globalData.token,
      log: (fields) => {
        if (fields.trace_id) this.globalData.lastTraceId = fields.trace_id;
        // 当前只用实时日志：ADR-29 的 /beacon 落库上报待 F5 补完
        wxApi.getRealtimeLogManager()?.info?.(fields.event ?? 'api', JSON.stringify(fields));
      },
    });
  },

  /** 写入 token（当前由页面手动粘贴；真实流程由登录回调调用）。 */
  setToken(token) {
    this.globalData.token = token;
    // ⚠️ 这里没有注入口（app.js 本身不可测，它是装配层）：storage 写失败会**原样抛出**，
    //    不吞——"token 没存上"若被吞掉，表现是"用户每次都要重新登录"且日志里什么都没有。
    //    `storage.js` 与 `wx-api.js` 都遵守同一口径（见各自的 @limitation：不吞异常）。
    this.globalData.storage.setString(TOKEN_KEY, token);
  },
});
