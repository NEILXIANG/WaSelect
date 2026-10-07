/**
 * 职责：待付款倒计时文案（剩余清单 4-11 / A24）。纯函数：时间由调用方传入（不读时钟，F10 / vm-guard 同口径）。
 *
 * @why 订单有支付窗口（expires_at，服务端到点关单）：用户不知道还剩多久，就会"先去比个价再回来付"，
 *      回来时单已关、库存已释放——只能重新下单。倒计时把这件事摆在眼前。
 * @why 到点含等号（`now >= expires`）：与服务端关单与 mark-paid 迟到判定同一口径（KD-7），
 *      页面说"已过期"的那一刻，服务端也确实不再接受这笔支付。
 * @limitation 显示的是**本机时钟**算出的剩余时间：手机时间被改过会不准（改快了会提前收起支付方式）；
 *             真正的截止由服务端判定，页面到点后会向服务端核对订单，以服务端状态为准。
 */

/**
 * 到点之后的文案（`expired: true` 时的 `text`）。
 * @why 到点后支付页**不只换这句文案**（P2-35）：薄壳会收起支付方式、换成关闭屏
 *      （`pages/pay/index.vm.js` 的 `EXPIRED_CLOSED_TEXT`），并向服务端核对一次订单真值。
 *      关单由服务端作业执行（每分钟一轮），到点那一秒核对多半还是 pending——所以关闭屏不等服务端，
 *      按截止时刻先关；核对结果若是「其实已付」，再换成「无需再支付」。
 *      ⚠️ 这里曾写「用户下拉即可看到已关闭」——**不成立**：没有任何页面开启下拉刷新（enablePullDownRefresh），
 *      能让人看到新状态的只有重新进页 / 切回前台（onShow 重取）。
 */
export const EXPIRED_TEXT = '支付时间已到，订单将自动关闭';

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {unknown} expiresAt 订单 `expires_at`（ISO 串）
 * @param {number} nowMs 当前毫秒（由页面薄壳传 `Date.now()`）
 * @returns {{text: string, expired: boolean}}
 */
export function countdownText(expiresAt, nowMs) {
  const exp = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(exp) || !Number.isFinite(nowMs)) return { text: '', expired: false };
  const leftMs = exp - nowMs;
  if (leftMs <= 0) return { text: EXPIRED_TEXT, expired: true };
  // 向上取整到秒：剩 1.6 秒显示 00:02，不在还有时间时显示 00:00
  const total = Math.ceil(leftMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return { text: `请在 ${clock} 内完成支付`, expired: false };
}
