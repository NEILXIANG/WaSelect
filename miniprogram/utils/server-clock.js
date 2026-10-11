/**
 * 职责：用响应头 `Date` 估算"手机时钟比服务端快 / 慢多少"，给要判付款截止的页面一个校准过的当前时刻
 * （MP-8，第二轮审计 2026-10-11）。纯函数：时刻由调用方传入，本文件不读时钟。
 *
 * @why 支付页 / 订单详情 / 订单列表按 `expires_at` 判"还能不能付"、走倒计时，原先用的是手机本机时钟。
 *      时钟偏快几分钟的手机会提前显示"支付时间已到"、收起支付按钮——服务端其实还收这笔钱，买家却付不了。
 *      （偏慢则相反：按钮还在、服务端已关单，会被支付接口的 40904 兜住，不会扣错钱。）
 * @why 用 `Date` 响应头而不是新增"服务端时间"接口：每个响应本来就带，零额外请求、零契约改动。
 * @measured(2026-10-11, 本地 sim)：Express 直接回 `Date: Sun, 11 Oct 2026 06:08:36 GMT`；
 *      经本地 3000 端口转发后头名变成小写 `date`——所以头名**不区分大小写**查找。
 *      Node 22：`Date.parse('Sat, 10 Oct 2026 14:03:07 GMT')` → 1791640987000；`Date.parse('not a date')` → NaN。
 * @limitation 一：`Date` 头只到秒，且含网络往返时间，误差在 1~2 秒量级；偏差小于 `SKEW_APPLY_MS` 时不校准
 *              （不让倒计时随每个响应来回跳），只纠正"明显不准"的时钟。
 * @limitation 二：真机上 `res.header` 的键名大小写未实测（AppID 未下来，地基清单 F14 外部阻塞）——按不区分大小写读，两种都接得住。
 * @limitation 三：只校准"判截止"的几处；"刚在浏览器发起过付款"这类本机记录仍用本机时钟（记与比都在本机，偏差自洽）。
 * @tradeoff 校准值是"最近一个响应"给的，不做平滑：换来的是实现只有两个纯函数；代价是网络慢的那一次会带进几秒误差，
 *           被阈值挡住、不影响显示。
 */

/** 偏差达到这个毫秒数才校准（30 秒：远大于 Date 头的秒级精度 + 往返时间，远小于 30 分钟付款窗口）。 */
export const SKEW_APPLY_MS = 30000;

/**
 * 响应头 → 服务端比本机快多少毫秒（负数 = 本机偏快）。
 * @param {unknown} header `wx.request` 成功回调的 `res.header`
 * @param {number} localNowMs 收到响应时的本机毫秒
 * @returns {number|null} null = 头缺失 / 解析不了（不校准）
 */
export function skewFromHeaders(header, localNowMs) {
  if (header === null || typeof header !== 'object' || !Number.isFinite(localNowMs)) return null;
  const key = Object.keys(header).find((k) => k.toLowerCase() === 'date');
  const raw = key === undefined ? undefined : header[key];
  if (typeof raw !== 'string' || raw === '') return null;
  const serverMs = Date.parse(raw);
  return Number.isFinite(serverMs) ? serverMs - localNowMs : null;
}

/**
 * 判截止用的"当前时刻"：偏差够大就按服务端时刻算，否则用本机时刻（@see @limitation 一）。
 * @param {number} localNowMs 本机毫秒（页面薄壳传 `Date.now()`）
 * @param {unknown} skewMs `skewFromHeaders` 的结果（存于 `app.globalData.clockSkewMs`；没有 = 不校准）
 */
export function serverNowMs(localNowMs, skewMs) {
  return Number.isFinite(skewMs) && Math.abs(skewMs) >= SKEW_APPLY_MS
    ? localNowMs + skewMs
    : localNowMs;
}
