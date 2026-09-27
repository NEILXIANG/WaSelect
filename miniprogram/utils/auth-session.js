/**
 * 职责：小程序登录会话的**唯一编排点**（I2）——`wx.login` code → `/auth/wechat/login` → token。
 *
 * @why 登录链**必须绕过带重登能力的请求器**：`request.js` 的 relogin 本身要发登录请求，
 *      若登录请求也走同一个请求器，收到 40101 时会再次进入同一个 single-flight 的
 *      Promise——**等自己结束，死锁**。所以调用方（app.js）要给 `deps.api` 传一个
 *      **非鉴权请求器**（不挂 token、不配 relogin）。
 *
 * @why 编排独立成模块而不是写在 app.js：app.js 是装配层（不可测，见它的 @limitation），
 *      而"什么时候登、code 空怎么办、响应缺 token 怎么办"都是**判断**——
 *      判断必须能被单测钉住（约束十一同一条理由）。
 *
 * @limitation 一：`wx.login` 是**回调式**，这里包一层 Promise；宿主没有超时回调，
 *              超时表现为"什么都不发生"——⚠️ 本模块**不设超时**：给 Promise 加定时器
 *              就要注入时钟，而微信侧超时是极边缘故障；真出现时的表现是
 *              "登录按钮转了但没反应"，可接受，不为此引入复杂度。
 * @limitation 二：429（登录限流）**不重试**，原样抛——登录被限流的正确反应是
 *              让用户稍后再来，客户端自动重试只会把自己限得更死。
 * @limitation 三：token 的**写入**不在本模块（返回 token 字符串，由 app.js 调 `setToken`）。
 *              理由：setToken 会写 storage，而 storage 写失败要**原样抛出**（app.js @limitation）
 *              ——把写也包进来会让"没存上"与"登录失败"两种故障在同一条 catch 里混掉。
 *
 * @see ../app.js（装配：非鉴权请求器 + relogin 接线）；./request.js（relogin 的调用方）；
 *      server/src/app/wechat-login.ts（服务端：dev 替身下任意 code 可登）
 */

/**
 * `wx.login` → code（Promise 化）。
 * @param {import('./wx-api.js').WxApi} wx 宿主能力入口
 * @returns {Promise<string>}
 * @why code 为空串按**失败**抛：空 code 发给服务端是 40101，而把"微信没给 code"
 *      表现成"登录被拒"会把排查方向引到服务端——那是两种完全不同的故障。
 */
export function wxLoginCode(wx) {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        const code = res && typeof res.code === 'string' ? res.code : '';
        if (code === '') reject(new Error('wx.login 未返回 code'));
        else resolve(code);
      },
      fail: (err) => reject(new Error(err && err.errMsg ? err.errMsg : 'wx.login 失败')),
    });
  });
}

/**
 * 完整登录一跳：`wx.login` → `POST /auth/wechat/login` → token 字符串。
 * @param {object} deps
 * @param {import('./wx-api.js').WxApi} deps.wx 宿主能力入口
 * @param {Function} deps.api **非鉴权**请求器（@why 见文件头）
 * @param {string} deps.apiBase 后端地址（config.js 的 `API_BASE`）
 * @param {string} [deps.traceId] 链路 id（不传由请求器新建）
 * @returns {Promise<string>} token
 */
export async function loginWithWechat(deps) {
  const code = await wxLoginCode(deps.wx);
  const res = await deps.api({
    url: `${deps.apiBase}/api/v1/auth/wechat/login`,
    method: 'POST',
    data: { code },
    traceId: deps.traceId,
  });
  // ⚠️ 响应缺 token 按**失败**抛而不是当"登了个匿名态"：
  //    拿到空 token 写回 storage 的表现是"每次都 40101、每次都重登、每次都失败"，
  //    而表面症状是"登录永远不成功"，离根因隔了两层。
  if (!res || typeof res.token !== 'string' || res.token === '') {
    throw new Error('登录响应缺少 token（响应形状漂移？）');
  }
  return res.token;
}
