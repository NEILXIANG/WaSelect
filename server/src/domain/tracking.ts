/**
 * 职责：承运商 + 运单号 → 官方查件链接（剩余清单 3-5 / B6）。纯函数。
 *
 * @measured(trackings.post.japanpost.jp, 2026-10-06)：英文查件页表单为
 *   `<form action="/services/srv/search" method="get">`，单号字段 `requestNo1`…`requestNo10`（maxlength 16），
 *   提交按钮 `search`（image，提交时带 search.x / search.y），隐藏字段 `locale=en`、`startingUrlPatten=`（原文拼写如此）。
 *   直接 GET `…/services/srv/search?requestNo1=EE123456789JP&search.x=1&search.y=1&locale=en&startingUrlPatten=` → 200，
 *   结果页回显该单号（虚构单号显示 not found）——即无需会话即可直达。
 * @why 以**单号形态**为主判据：发货时承运商是自由文本（"EMS / ems / 日本郵便"都有人写），
 *      而日本邮便国际单号是 UPU S10 格式（2 字母 + 9 数字 + JP，查件页示例 "AA123456789JP"），形态稳定。
 * @why 认不出就返回 null，不猜：给买家一个错的链接，比只显示运单号更糟（他会以为包裹丢了）。
 * @why locale=en：收件人在美国。
 * @limitation 只认日本邮便（MVP 唯一承运商，见 E12）；接别的承运商在 CARRIERS 表里加一行。
 */
const S10_JP = /^[A-Z]{2}\d{9}JP$/;

const JAPAN_POST = {
  names: [
    'ems',
    'epacket',
    'e-packet',
    'japan post',
    'japanpost',
    'jppost',
    'jp post',
    '日本郵便',
    '日本邮便',
    '国際小包',
    '国际小包',
  ],
  url: (n: string): string =>
    `https://trackings.post.japanpost.jp/services/srv/search?requestNo1=${encodeURIComponent(n)}` +
    '&search.x=1&search.y=1&locale=en&startingUrlPatten=',
};

export function trackingUrl(carrier: string | null, trackingNo: string | null): string | null {
  const n = (trackingNo ?? '').replace(/\s+/g, '').toUpperCase();
  if (n === '') return null;
  if (S10_JP.test(n)) return JAPAN_POST.url(n);
  const c = (carrier ?? '').trim().toLowerCase();
  if (JAPAN_POST.names.some((name) => c.includes(name))) return JAPAN_POST.url(n);
  return null;
}

/** 响应展开用：有链接 → `{tracking_url}`，没有 → `{}`（整键省略，与 tracking_no 同口径）。 */
export function withTrackingUrl(
  carrier: string | null,
  trackingNo: string | null,
): { tracking_url?: string } {
  const url = trackingUrl(carrier, trackingNo);
  return url === null ? {} : { tracking_url: url };
}
