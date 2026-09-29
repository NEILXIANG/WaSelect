/**
 * 职责：商品详情页（`pages/detail`）的**视图逻辑**——纯函数，不读宿主、不做 IO、不发请求。
 *
 * @why 与首页 vm 同一条理由（CLAUDE.md 约束十一）：详情页的判断——
 *      "没图给占位"、"描述为空整段隐藏"、"哪些字段给用户看"——
 *      写在 `Page({...})` 里就只剩真机点这一种验证方式。抽出来，24→N 条单测钉住。
 *
 * @why 刻意**不透出**契约里的 `hs_code` / `customs_desc_en` / `compliance_tags`：
 *      它们是**报关合规信息**（D-39/D-42，管理员上架核对用）。给用户看只会制造疑问——
 *      "SPF 是什么？为什么这个商品带 quasi_drug 标签？"——而答案没有一个是用户能用的。
 *      ⚠️ 这是"少显示"，不是"隐藏缺陷"：合规标签决定的是**能不能上架**，上架了就该让用户安心。
 *
 * @limitation 一：原产地的展示名（`JP → 日本`）落在本文件这一处，与首页的分类展示名
 *              同一条欠账（后端契约只给 ISO 码，没有展示名；见 home vm @limitation 一）。
 * @limitation 二：**库存数字不展示**，只给"已售罄"一个布尔态。
 *              @why 精确库存（"还剩 3 件"）是运营手段，会逼着每次改动都同步前后端口径；
 *              MVP 只要回答"能不能买"这一个问题。
 * @limitation 三：`weight_g` 展示成"约 N g"——它是**申报重量**（含包材口径在报价域另有
 *              PACKAGING_WEIGHT_G，D-42），与商品实重本就有差；"约"字是刻意留的余地。
 *
 * @see ../home/index.vm.js（首页 vm，同一套约束）；../../utils/price-format.js（displaySubLine）；
 *      ../../utils/placeholder.js（占位图真源）；contracts/api-contract.yaml（Product 形状）
 */

import { displaySubLine } from '../../utils/price-format.js';
import { PLACEHOLDER_IMAGE, imageUrl } from '../../utils/placeholder.js';

/** 原产地 ISO 码 → 展示名。@see @limitation 一 */
const ORIGIN_LABELS = { JP: '日本' };

/**
 * 价格口径说明（D-32 / D-69②：商品价含美国关税，DDP 由 KK 预缴计入定价；运费按重量单列）。
 * @why 写在 vm 常量而不是 wxml：口径变时改这一处，且被单测钉住（提审前必须项，AJ-176 标注）。
 * @limitation 口径本身是店铺级政策，不随商品变；将来若出现"不含关税"的商品，要改成由契约下发。
 */
export const DUTY_NOTE = '价格含美国关税，国际运费按重量在结算时计算';

/**
 * `GET /products/{id}` 的 Product → 详情视图数据。
 * @param {unknown} product 契约 `Product`（请求失败时页面根本不会调这里）
 * @returns {{title: string, priceJpy: unknown, subPrice: string, images: string[],
 *            description: string, specs: Array<{label: string, value: string}>, soldOut: boolean,
 *            notes: string[]}}
 * @why `priceJpy` **原样透传、不做任何兜底**（与首页同一口径）：`ws-price` 对非整数
 *      会响亮失败，在这里补 0 会显示 `0 円`——那是价格组件最贵的失败形态。
 */
export function detailView(product) {
  const p = product && typeof product === 'object' ? product : {};
  return {
    title: typeof p.title === 'string' ? p.title : '',
    priceJpy: p.price_jpy,
    subPrice: displaySubLine(p.display),
    images: imagesOf(p.images),
    description: typeof p.description === 'string' ? p.description.trim() : '',
    specs: specsOf(p),
    soldOut: Number(p.stock) === 0,
    notes: notesOf(p),
  };
}

/**
 * 价格区下方的两行说明：关税口径 + 发货时限承诺（FTC 邮购规则，D-39⑦；AJ-180）。
 * @why 时限数字**只取服务端下发**（`ship_within_business_days`，配置 SHIP_WITHIN_BUSINESS_DAYS）：
 *      这是法律承诺，前端写死就是"运营改了配置、页面还是旧承诺"；拿不到合法正整数就不出这一行——
 *      写错的承诺比不写更糟（FTC 未写时限时默认 30 天，不写不违规）。
 */
function notesOf(p) {
  const days = p.ship_within_business_days;
  return Number.isInteger(days) && days > 0
    ? [DUTY_NOTE, `付款后 ${days} 个工作日内发出`]
    : [DUTY_NOTE];
}

/** ImageSet[] → 主图 URL 列表；一条图都没有 → [占位图]（不留空数组，轮播会整个消失）。 */
function imagesOf(images) {
  if (!Array.isArray(images)) return [PLACEHOLDER_IMAGE];
  const urls = images.map(imageUrl).filter((u) => u !== '');
  return urls.length > 0 ? urls : [PLACEHOLDER_IMAGE];
}

/** 用户可见的规格行：原产地 + 重量。报关字段不进来（@see 文件头 @why）。 */
function specsOf(p) {
  const specs = [];
  const origin = typeof p.origin_country === 'string' ? p.origin_country : '';
  if (origin !== '') {
    // 展示名缺映射时退回 ISO 码：显示 "DE" 难看，但比"产地一栏空白"诚实
    specs.push({ label: '原产地', value: ORIGIN_LABELS[origin] ?? origin });
  }
  if (Number.isInteger(p.weight_g) && p.weight_g > 0) {
    specs.push({ label: '重量', value: `约 ${p.weight_g} g` });
  }
  return specs;
}
