/**
 * 职责：上传图 → 三档 webp 字节（sharp 适配器，I2 U-I2）。
 *
 * @why `.rotate()`（无参）必须先于缩放：它按 EXIF orientation 归正并**清掉该标记**。
 *      iPhone 直出横拍图常带 orientation=6，不归正则缩出来的图在小程序里是躺倒的，
 *      而管理端预览（浏览器大多自动归正）看不出来——只有真机验收才暴露，太晚。
 *
 * @why `withoutEnlargement: true`：100px 的图放大到 1200px 只会糊且体积更大，
 *      缩略图比原图大是取档方向级别的荒谬（D-46 同类：错了还静默）。
 *
 * @limitation 一：输出统一 **webp**（键形已在 domain 钉死 `.webp`，两处一致由
 *              `imageObjectKey` 单一真源保证）。代价：极端老的 webview 不认 webp——
 *              小程序基础库 2.9+ 与现代浏览器都支持，真机验收若翻车改这一处常量即可。
 * @limitation 二：quality 80 是拍的（肉眼无损与体积的常用折中）；没有实测基准，
 *              等真实商品图进来后运营可评。
 * @limitation 三：输入按**调用方已 sniff** 假设（路由先过 `sniffImageType`）；
 *              垃圾字节这里照样会 reject（sharp 解码失败），不装认识。
 *
 * @tradeoff 逐档串行而不是 `Promise.all`：sharp 内部有线程池，三档并发对
 *           10MB 原图的内存峰值是三倍；管理端上传不是热路径，稳比快重要。
 *
 * @see domain/upload-image.ts（档位定义与键形）；contracts/api-contract.yaml（/admin/upload）
 */
import sharp from 'sharp';
import { IMAGE_TIERS, imageObjectKey, type ImageTierName } from '../domain/upload-image.js';

export interface ResizedTier {
  name: ImageTierName;
  key: string;
  bytes: Buffer;
  contentType: 'image/webp';
}

/** 统一输出 quality（@limitation 二）。 */
const WEBP_QUALITY = 80;

/**
 * 原图字节 → 三档 webp（EXIF 归正 + 等比缩到档宽，小图不放大）。
 * @param imageId IdGen 产出（键形由 domain 单一真源 `imageObjectKey` 保证）
 */
export async function resizeToTiers(input: Buffer, imageId: string): Promise<ResizedTier[]> {
  const base = sharp(input).rotate();
  const out: ResizedTier[] = [];
  for (const tier of IMAGE_TIERS) {
    const bytes = await base
      .clone()
      .resize({ width: tier.width, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    out.push({
      name: tier.name,
      key: imageObjectKey(imageId, tier.name),
      bytes,
      contentType: 'image/webp',
    });
  }
  return out;
}
