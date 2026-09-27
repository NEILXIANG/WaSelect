/**
 * 职责：把 `wx.request` 的**调用形状**搬到 Node 侧，底层走真实 TCP（fetch）。
 *
 * @why 这是"只有第三方才 mock"的边界：
 *      - 被 mock 的是**宿主能力**（微信的 HTTP 通道），不是我们自己的代码；
 *      - 传输层是真的（真端口、真 TCP、真 HTTP），所以 header、状态码、body 解析都是真行为。
 *      我们自己的 `miniprogram/utils/request.js` 全链路真跑，没有被替身短路的部分。
 *
 *      反过来，如果连 fetch 也换成"返回写死对象的函数"，那测的只是我们的 if 分支，
 *      "服务端错误体到底叫 code 还是 error.code"这类**接口对齐问题一条也测不出来**——
 *      而这类问题恰恰是前后端分离里最高频的线上事故。
 *
 * @limitation 一：**不模拟真机的域名校验**。微信要求 https + 后台配置 request 合法域名，
 *              本地 `http://localhost:3000` 只能在开发者工具勾选"不校验合法域名"时跑通。
 *              这条约束无法在 Node 侧验证，属上线前真机验证清单的手工项。
 * @limitation 二：**不模拟 `enableHttp2` / `enableQuic` / 上传下载 / 证书校验**，
 *              当前链路用不到；等真的用了这些能力，这里必须同步补，否则测试会给出虚假的安全感。
 * @limitation 三：超时用 `AbortSignal.timeout`，与微信的 `timeout` 语义接近但不完全相同
 *              （微信只约束建连+首包的一部分阶段）。超时相关的精确行为仍需真机验证。
 *
 * @see 微信官方文档 wx.request：https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html
 */
export interface WxRequestOption {
  url: string;
  method?: string;
  data?: unknown;
  header?: Record<string, string>;
  timeout?: number;
  success?: (res: { statusCode: number; data: unknown; header: Record<string, string> }) => void;
  fail?: (err: { errMsg?: string }) => void;
  complete?: () => void;
}

/** 与 wx.request 同签名的注入函数；生产代码里由 `deps.request` 替换掉真实的 wx.request。 */
export function fakeWxRequest(option: WxRequestOption): void {
  void run(option).finally(() => option.complete?.());
}

async function run(option: WxRequestOption): Promise<void> {
  const method = (option.method ?? 'GET').toUpperCase();
  const header = { ...(option.header ?? {}) };
  let url = option.url;

  // GET 的 data 在微信里会被拼成 query string（POST 则是 body）——照抄这个行为，
  // 否则"GET 带参数"的代码在真机上能用、在测试里却丢了参数。
  if (method === 'GET' && option.data !== undefined && option.data !== null) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(option.data as Record<string, unknown>)) {
      u.searchParams.set(k, String(v));
    }
    url = u.toString();
  }

  const init: RequestInit = { method, headers: header };
  if (method !== 'GET' && option.data !== undefined) {
    init.body = JSON.stringify(option.data);
  }
  // exactOptionalPropertyTypes 下 signal 不能显式传 undefined，只能按需挂上
  if (option.timeout !== undefined) init.signal = AbortSignal.timeout(option.timeout);

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    // 微信会把 JSON 响应自动反序列化；content-type 不是 json 时给字符串——同样照抄
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    let data: unknown = text;
    if (isJson && text.length > 0) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = text; // 解析失败时不抛，与微信一致：交给调用方自己判
      }
    }
    // 注意：非 2xx 在微信里也是走 **success**（只有网络层失败才走 fail）。
    // 这一步如果写错，前端会出现"业务错误被当成网络错误"的经典 bug。
    option.success?.({
      statusCode: res.status,
      data,
      header: Object.fromEntries(res.headers.entries()),
    });
  } catch (e) {
    option.fail?.({ errMsg: e instanceof Error ? e.message : String(e) });
  }
}
