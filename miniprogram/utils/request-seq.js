/**
 * 职责：**请求序号**——同一个槽位连续发多个请求时，只接受最后一次的结果（B36 / AJ-219）。
 *
 * @why 首页"切分类/搜索"与购物车"改数量"都是同一个槽位连着发请求：
 *      弱网或服务端抖动时**后发的先回来**（第 2 页比第 3 页慢是常态），
 *      旧响应覆盖新结果的表现是——切到「食品」却还看到厨刀、
 *      改完数量显示的合计是上一次的、**去结算**还带着过期的合计跳走。
 *      三条都不报错，且用户的归因不会指向前端（"这个站数据乱"），
 *      所以只能靠"请求序号"这种结构性手段，而不是靠重试或加注释。
 *
 * @why 抽成共享层而不是在首页与购物车各写一遍：两者是**同一条规则**，
 *      写两遍的必然结果是漂移（一处判断 `<`、一处判断 `!==`），
 *      而漂移后的失败形态是"某个页面偶发乱序"——最难归因的一类（约束九）。
 *
 * @limitation 只判"过不过期"，**不发请求、不取消请求**：
 *              没有用 `AbortController`（小程序 `wx.request` 的 abort 语义与 Promise
 *              取消不一致），代价是过期请求仍会跑完并占用连接；
 *              @tradeoff 换来的是"不需要为每个请求维护句柄"，
 *              本项目的请求量（列表 20 条/页、报价防抖 400ms）不值得那套复杂度。
 *
 * @see ../pages/home/index.js（reload / loadMore）；../pages/cart/index.js（fetchQuote）
 */

/**
 * 这个响应是不是**过期**的（已经有更新的请求发出去了）。
 *
 * @param {unknown} seq 本次请求发出时领到的序号
 * @param {unknown} current 当前最新序号（页面实例上的计数器）
 * @returns {boolean} true = 丢弃这次的结果
 *
 * @why 非整数一律判为**不过期**：序号本身来自页面自己的计数器，取不到只有两种可能——
 *      wxml 传错形态、或有人把计数器写成了别的类型。这时"丢弃"会让列表**永远不更新**
 *      （比乱序严重得多），所以降级方向是"宁可显示旧数据，也不要白屏/空列表"。
 */
export function isStale(seq, current) {
  if (!Number.isInteger(seq) || !Number.isInteger(current)) return false;
  return seq < current;
}

/**
 * 领一个新序号（只做 +1 与归一，不碰状态）。
 *
 * @param {unknown} current 当前序号；非整数从 1 重新计数（不信任脏值）
 * @returns {number}
 * @why 归一而不是"脏了就抛"：计数器脏一次就让页面从此无法刷新，
 *      而"从 1 重数"的代价只是可能多丢一次过期响应——那条响应本来也该丢。
 */
export function nextSeq(current) {
  return Number.isInteger(current) && current > 0 ? current + 1 : 1;
}
