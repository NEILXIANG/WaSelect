/**
 * 职责：开发期商品图（三端联动模拟 2026-10-08）——给**没有图**的商品生成一张商品卡式图片，
 *       走与真实上传**同一条**缩放管线（`resizeToTiers` → 三档 webp → ObjectStorage），写回 `products.images = [{image_id}]`。
 *
 * @why 种子商品一张图都没有：管理端列表、小程序首页 / 详情 / 购物车只剩占位图，
 *      "图片版式、三档尺寸、长图裁切、上传后买家看到的图"这些问题在开发期一个都看不见。
 * @why 自己画而不是下载网图：不引外部素材（版权、来源不明），也不依赖网络；
 *      用 SVG 画"分类底色 + 日文原名 + 中文名 + 价格"，渲染成 PNG 后交给与生产相同的缩放函数。
 * @limitation 一：只用于本地开发（调用方只在 development + fs 存储时调用）；生产图片由运营在管理端上传。
 * @limitation 二：中日文字形依赖本机字体（macOS 自带 Hiragino / PingFang；Linux 需装 Noto CJK），缺字体时显示为方块，不影响流程。
 * @see server/src/adapters/image-resize.ts；scripts/dev-up.ts（「开发商品图」步骤）
 */
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Db } from '../server/src/adapters/db.js';
import { resizeToTiers } from '../server/src/adapters/image-resize.js';
import type { ObjectStorage } from '../server/src/ports/storage.js';

/** 分类底色（与管理端分类一致的四类；未知分类用中性灰）。 */
const PALETTE: Readonly<Record<string, [string, string]>> = {
  beauty: ['#F6E3E7', '#D98FA0'],
  daily: ['#E7EEF3', '#8FA9BD'],
  kitchen: ['#EFE9E1', '#A88F72'],
  food: ['#EEF2E3', '#93A86B'],
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 一张 1200×1200 的商品卡式 PNG。 */
export async function renderProductImage(p: {
  title: string;
  titleJa: string | null;
  category: string;
  priceJpy: number;
}): Promise<Buffer> {
  const [bg, accent] = PALETTE[p.category] ?? ['#EEEEEE', '#999999'];
  const ja = esc((p.titleJa ?? p.title).slice(0, 22));
  const zh = esc(p.title.slice(0, 18));
  const font = "'Hiragino Sans','PingFang SC','Noto Sans CJK JP','Noto Sans CJK SC',sans-serif";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">
  <rect width="1200" height="1200" fill="${bg}"/>
  <circle cx="600" cy="470" r="300" fill="${accent}" opacity="0.35"/>
  <rect x="380" y="250" width="440" height="440" rx="48" fill="#FFFFFF" opacity="0.85"/>
  <text x="600" y="505" font-size="150" text-anchor="middle" fill="${accent}" font-family="${font}">${esc(zh.slice(0, 1))}</text>
  <text x="600" y="860" font-size="54" text-anchor="middle" fill="#2B2A27" font-family="${font}">${ja}</text>
  <text x="600" y="940" font-size="46" text-anchor="middle" fill="#5C5850" font-family="${font}">${zh}</text>
  <text x="600" y="1060" font-size="44" text-anchor="middle" fill="${accent}" font-family="${font}">${p.priceJpy.toLocaleString('en-US')} 円</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * 给 `images = []` 的商品各配一张图；返回配了几件。已有图的商品不动（运营传过的图不会被覆盖）。
 */
export async function attachDevImages(db: Db, storage: ObjectStorage): Promise<number> {
  const rows = await db`
    select id, title, title_ja, category, price_jpy from products
     where coalesce(jsonb_array_length(images), 0) = 0 order by created_at`;
  let n = 0;
  for (const r of rows) {
    const png = await renderProductImage({
      title: String(r['title']),
      titleJa: (r['title_ja'] as string | null) ?? null,
      category: String(r['category']),
      priceJpy: Number(r['price_jpy']),
    });
    const imageId = randomUUID();
    for (const t of await resizeToTiers(png, imageId))
      await storage.put(t.key, t.bytes, t.contentType);
    await db`update products set images = ${db.json([{ image_id: imageId }])}, updated_at = now() where id = ${String(r['id'])}`;
    n += 1;
  }
  return n;
}
