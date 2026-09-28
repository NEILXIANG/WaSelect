/**
 * 职责：`POST /admin/upload` 的纯函数判定（I2 U-I1）——图片族嗅探、存储键形、档位定义。
 *
 * @why 图片类型按 **magic bytes** 嗅探，不信 multipart 的 Content-Type：
 *      那个头是客户端自己写的，伪造零成本；而"上传了一个 .exe 被当成图存进图床"
 *      的失效形态是静默的（图床会照常分发它）。按字节判，错一位都放不进来。
 *
 * @why `image_key`（契约 ImageSet 新增字段，AJ-143）= **detail 档的存储键**：
 *      ① Banner 展示用最大档（1200px），键直接可拼 URL；
 *      ② 不存原图——原图可能 10MB，banner 直出原图既慢又贵；
 *      ③ 绝不给"键族前缀"让消费方自己拼档位——那是靠字符串巧合工作（AJ-143 已否③）。
 *
 * @limitation 一：**不存原图**。将来档位尺寸要改（如 card 600→800），
 *              无法从已上传图重新生成，只能重传。换取的是存储量 -1/4 与无"原图外泄"面。
 * @limitation 二：只认 jpeg / png / webp 三族。**svg 永不放行**（脚本载体，
 *              `<image>` 与 <img> 都会执行）；heic（iPhone 直出）拒——sharp 默认不带
 *              libheif，放了也是在缩放处炸，不如在入口处给明白话（运营先转 jpeg）。
 * @tradeoff gif 不放行：动图在商品详情无 MVP 需求，且 gif 缩放要取帧，多一条分支。
 *
 * @see contracts/api-contract.yaml（ImageSet，0.6.8 增 image_key）；
 *      docs/自主决策记录.md AJ-143（image_key 由上传接口返回）、AJ-166（= detail 档键）
 */

/** 单文件上限 10MB（契约 /admin/upload 描述同步；改动两边一起改）。 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** 三档定义：键名与契约 ImageSet 的 URL 档键一一对应（单测双向比对钉死）。 */
export const IMAGE_TIERS = [
  { name: 'thumb', width: 200 },
  { name: 'card', width: 600 },
  { name: 'detail', width: 1200 },
] as const;
export type ImageTierName = (typeof IMAGE_TIERS)[number]['name'];

export type SniffedImageType = 'jpeg' | 'png' | 'webp';

/** magic bytes 嗅探：只认三族，不足判定长度不猜（@why 见文件头）。 */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'png';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 && // 'RIFF'
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50 // 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** id 只来自 IdGen（小写字母数字 + 连字符）；正则拦截是防"将来有人把外部输入接进来"。 */
const IMAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 存储键：`img/{imageId}/{tier}.webp`。id 非法 → 抛错（编程错误，折叠成 50000 是正确表现）。 */
export function imageObjectKey(imageId: string, tier: ImageTierName): string {
  if (!IMAGE_ID_PATTERN.test(imageId)) throw new Error(`image_id_invalid:${imageId.length}chars`);
  return `img/${imageId}/${tier}.webp`;
}

/** 契约 `ImageSet.image_key` 的唯一出处（= detail 档键，@why 见文件头）。 */
export function detailObjectKey(imageId: string): string {
  return imageObjectKey(imageId, 'detail');
}
