/**
 * 职责：列表里"第几张图加载失败"这个标记的**唯一算法**（审计 UX-004）。
 *
 * @why 图加载失败（CDN 404 / 域名未登记 / 图被删）在真机上留一个破图占位，
 *      与"商品本来就没图"在页面上是两件事——破图是坏的，空白占位是可接受的。
 *      收起 `<image>` 之后 `.ws-media` 自带的底色顶上来（app.wxss），看起来就是"这一件暂时没图"。
 *
 * @why 标记**按项**（per-item）而不是整页一个布尔值：这些 `<image>` 都在 `wx:for` 里，
 *      整页共用一个布尔值时第一张坏图会把整单 / 整页的商品图一起收起——
 *      买家读成"这家店全都没图"，而不是"这一件暂时没图"。
 *
 * @why 算法**只住在这里**而不是每个页面的 vm 各写一份：六个页面用的是同一个
 *      「按下标记 → 幂等 → 返回新数组」的动作，抄六遍的下场是某个页面漏掉幂等
 *      （同一张图会连着报好几次错，每报一次重渲一次列表），而且不报错。
 *
 * @limitation 一：按**下标**而不是按商品 id 记（与 `pages/detail` 的 `onGalleryError`、
 *              `pages/order-detail` 的 `onItemImgError` 同一口径）。
 *              @why 下标的代价是**列表增删会让标记错位**——所以调用方在整份替换列表的
 *                   那一次 `setData` 里必须把 `imgFailed` 一起清回 `[]`。
 *              @limitation 放弃的是"删掉一行后其余行的标记还能对得上"：换成
 *                   按 id 建 map 可以做到，但 WXML 里就要写 `imgFailed[item.productId]`
 *                   （官方数据绑定只写了 `object.key` 与 `array[0]`，动态键**未实测**），
 *                   用一个没验证过的写法去换一个边缘场景，不划算。
 * @limitation 二：返回 `null` 表示"不用 setData"，调用方不得把它当空数组写入 data。
 *
 * @see ../pages/detail/index.js（轮播的同形态实现）；../pages/order-detail/index.js（订单商品行）
 */

/**
 * 标上"第 index 张图加载失败"。
 *
 * @param {unknown} failed 当前的失败标记（`data.imgFailed`）
 * @param {unknown} index wxml `data-index` 带来的下标
 * @returns {Array<boolean>|null} 新的标记数组；`null` = 下标非法或这一项**已经标过**，调用方不必 setData
 *
 * @why 已经标过就返回 null 而不是照样给一份新数组：同一张图会连着报好几次错，
 *      每次都 setData 等于每报错一次就把整个列表重渲一遍。
 */
export function markImageFailed(failed, index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return null;
  const prev = Array.isArray(failed) ? failed : [];
  if (prev[i] === true) return null;
  const next = prev.slice();
  next[i] = true;
  return next;
}
