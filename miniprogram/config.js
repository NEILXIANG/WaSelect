/**
 * 职责：小程序端的环境配置（唯一真源）。
 *
 * @why 后端地址、主题入口这类"会随环境变的值"必须集中在一处，
 *      散落在页面里就会出现"改了三个地方、漏了第四个"，而且漏的那个只在对应页面才暴露。
 *
 * @why 用宿主的 `envVersion` **选**地址，而不是提审前手改一行常量再打包：
 *      小程序没有构建期环境注入（`process.env` 在这个运行时里不存在，
 *      `wx.uploadFile` 上去的是同一份产物，跑 develop / trial / release 三处）。
 *      手改的形态是**漏改**——而漏改只在真机上可见（开发者工具里永远是对的），
 *      表现是"正式版全站请求失败"，且没有任何一方报错说是地址错了。
 *      @measured（官方文档）：`wx.getAccountInfoSync().miniProgram.envVersion`
 *      合法值为 develop / trial / release，自基础库 2.10.0 起。
 *
 * @see CLAUDE.md 约束五（UI 不写死，随环境变化的值集中一处）；
 *      docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md（UI 由配置驱动）；
 *      ./utils/wx-api.ts（getAccountInfoSync 的唯一取用点）
 *
 * @limitation 一：`trial` / `release` 目前是**空串**（域名待 B9 一次定完，见 B5）。
 *      空串不是"配了 localhost"，是**故意没配**：`resolveApiBase` 遇到空串直接抛，
 *      于是"体验版/正式版没配域名"不会静默打到一个长得合法的地址上——
 *      这与服务端 `resolveStorage` 的 `needed()` 同一口径：**不静默补默认值**。
 *      ⚠️ 曾经这里接着写"于是在启动时就响亮失败"——**不成立**，已实测证伪（AJ-364）：
 *      仅仅抛出是不够的。`app.js` 的 `onLaunch` 若让它冒出去，`globalData.api` 会保持 `null`，
 *      页面 `app.globalData.api(...)` 抛的是 **TypeError**（与本因无关），形态是**白屏**，
 *      而这条 message 只在实时日志里——用户与审核员什么都看不到。
 *      正确形态是：由 `app.js` 接住它，换成 `utils/unconfigured-api.js` 的**替身请求器**，
 *      让每个请求以 `ApiError(-2)` 继续把这个原因表达到页面已的错误出口上。
 *      ⚠️ 提审前必须把这两项填上：审核员打开的是**正式版**（envVersion=release）。
 * @see ../app.js（唯一调用方与接住它的地方）；./utils/unconfigured-api.js（替身请求器）
 * @limitation 二：⚠️ 小程序 `wx.request` 的域名必须在**微信后台配置为合法域名**才能访问，
 *      且每月只能改 5 次。因此这三个环境的域名要一次性规划好，不能临时换。
 *      `http://localhost` 仅在开发者工具里勾选"不校验合法域名"时可用。
 *      @see ../../deploy/wechat-domains.json（要在后台登记的域名清单，B5）
 * @limitation 三：`envVersion` 拿不到时（基础库 < 2.10.0）回落 **develop（localhost）**。
 *      方向是刻意的：回落成 localhost 的表现是"全站请求失败"（响亮、立刻有人报）；
 *      反过来回落成 release 的表现是"开发/体验版打到了生产库"（静默写坏数据）。
 */

/**
 * 各环境的 API 根地址。键是宿主的 `envVersion`。
 *
 * @why 三档而不是两档：`trial`（体验版）是提审前最后一个能真机验证的环境，
 *      让它指向 localhost 就等于"提审前无法真机联调"，只能靠猜。
 * @why `develop` 是 http + localhost：开发者工具勾"不校验合法域名"后可用，
 *      也是**唯一**一个不需要在微信后台登记的域名。
 */
export const API_BASES = {
  develop: 'http://localhost:3000',
  /** 体验版（真机联调、提审前演练）。⚠️ 待 B9 定域名后填；必须是 https 公网地址。 */
  trial: '',
  /** 正式版（审核与线上）。⚠️ 待 B9 定域名后填；必须是 https 公网地址。 */
  release: '',
};

/**
 * 开发版**真机预览 / 真机调试**用的 API 根地址（开发机的局域网地址，如 `http://192.168.1.10:3000`；P2-33）。
 *
 * @why 真机预览的 envVersion 也是 `develop`，原来一律给 `API_BASES.develop`（localhost）——
 *      手机上的 localhost 是手机自己，每个请求都 `request:fail`，页面说"网络不太稳定，请检查网络"，
 *      把排障方向带到网络上，而真正的原因是"这个地址在手机上没有意义"。
 * @why 默认**空串**（不猜局域网 IP）：空串 ⇒ `resolveApiBase` 抛 `api_base_not_configured:develop-device`，
 *      由 app.js 换成替身请求器（-2），页面上直接显示这句说明——与 trial / release 没配地址同一条路。
 * @limitation 只在拿得到 platform 且不是 `devtools` 时生效；拿不到 platform（宿主过旧）保持原行为（localhost）。
 *              ⚠️ 需要开发者工具"不校验合法域名"或真机调试打开调试模式，http 局域网地址才放行（同 develop 一条）。
 *              这是个人开发机地址：填了**不要提交**（换网络就变）。
 */
export const DEVELOP_DEVICE_API_BASE = '';

/** 开发者工具（模拟器）的 platform 值（@see utils/wx-api.ts getPlatform）。 */
const DEVTOOLS_PLATFORM = 'devtools';

/**
 * 按 `envVersion` 选 API 根地址。
 *
 * @param {string | undefined} envVersion 宿主的 `wx.getAccountInfoSync().miniProgram.envVersion`
 * @param {string | undefined} [platform] 宿主的 `platform`（`devtools` / `ios` / `android` …；P2-33）。
 *        只影响 develop：非 devtools ⇒ 真机，改用 `DEVELOP_DEVICE_API_BASE`；不传 / 空串 ⇒ 原行为。
 * @returns {string} 可用的 API 根地址
 * @throws 目标环境**没配**地址时抛——不静默打到一个错误的地址；抛出后由 app.js 接住并换成替身请求器，
 *         页面显示错误态而不是白屏（AJ-364；复核 2026-10-06 订正原"宁可启动白屏"）
 *         （@see @limitation 一）
 */
export function resolveApiBase(envVersion, platform) {
  // ⚠️ 未知/缺失一律按 develop 处理（方向见 @limitation 三），不是按 release。
  const key = Object.prototype.hasOwnProperty.call(API_BASES, envVersion) ? envVersion : 'develop';
  // P2-33：开发版跑在真机上时 localhost 没有意义（@see DEVELOP_DEVICE_API_BASE）
  const onDevice =
    key === 'develop' &&
    typeof platform === 'string' &&
    platform !== '' &&
    platform !== DEVTOOLS_PLATFORM;
  if (onDevice) {
    if (DEVELOP_DEVICE_API_BASE === '') {
      throw new Error(
        'api_base_not_configured:develop-device——开发版在真机上连不到开发机的 localhost，' +
          '请在 config.js 的 DEVELOP_DEVICE_API_BASE 填入开发机局域网地址（如 http://192.168.1.10:3000），' +
          '或改用体验版',
      );
    }
    return DEVELOP_DEVICE_API_BASE;
  }
  const base = API_BASES[key];
  if (typeof base !== 'string' || base === '') {
    throw new Error(
      `api_base_not_configured:${key}——` +
        `config.js 的 API_BASES.${key} 是空的，请在域名定完后填入 https 公网地址（提审前必须填）`,
    );
  }
  return base;
}
