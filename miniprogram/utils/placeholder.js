/**
 * 职责：商品图占位的**唯一真源**。
 *
 * @why "商品没图时显示什么"是全端口径（首页卡片、详情页主图、购物车行……都会遇到），
 *      真源一旦住在某个页面里，第二个页面要么 import 页面目录（跨页耦合），
 *      要么自己再写一份——两份的表现是"哪天换了占位图，有一页没换"，
 *      而它不报错：用户只会看到"这个页面的图怪怪的"。
 *
 * @why 是**本地资源**而不是远端 URL：占位图必须在不依赖网络/图床的情况下一定能显示，
 *      否则"图床挂了"和"商品没图"两种故障会叠加成同一种空白，无法区分。
 *      文件本体 `assets/placeholder.png`（300×300 斜纹灰，≈2KB）——
 *      斜纹是刻意的：纯灰块和"图片还没加载出来"在弱网下无法区分。
 *
 * @limitation 300×300 是正方形：依赖它 `widthFix` 布局下卡片图是一比一。
 *            真实商品图必须统一为一比一（运营口径），否则列表参差。
 *
 * @see ../pages/home/index.vm.js（第一个消费方）；assets/placeholder.png（文件本体）
 */

/** 商品图占位路径（小程序包内绝对路径）。 */
export const PLACEHOLDER_IMAGE = '/assets/placeholder.png';

/**
 * 从契约 ImageSet（或裸字符串）取商品图 URL。
 *
 * @param {unknown} image `ImageSet{thumb,card,detail}` 或裸字符串（存量形态）
 * @returns {string} URL；取不到 → **空串**（是否回落占位图由调用方决定）
 *
 * @why 取值顺序是 `card → thumb → detail`：列表/详情主位要的是横图位（card），
 *      没有才退缩略图。⚠️ 用「非空判断」而不是 `??`——`card: ''` 不是 nullish，
 *      `??` 会在 thumb 有值时仍然返回空串（实测踩过：单测第一条就红了）。
 */
export function imageUrl(image) {
  if (typeof image === 'string') return image.trim();
  const o = image !== null && typeof image === 'object' ? image : {};
  for (const src of [o.card, o.thumb, o.detail]) {
    if (typeof src === 'string' && src.trim() !== '') return src.trim();
  }
  return '';
}
