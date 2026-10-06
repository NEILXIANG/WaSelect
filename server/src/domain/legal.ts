/**
 * 职责：法务文档地址与商家信息（剩余清单 4-1 / S1-E7）——纯函数。
 *
 * 地址形态：`<LEGAL_BASE_URL>/legal/<doc>/#<lang>`——一份文档一张静态页（checkout 静态站 `checkout-static/legal/<doc>/`），
 * 三种语言是页内锚点。
 *
 * @why 一份文档一张页、语言用锚点：律师定稿后"换文本"只动 4 个文件而不是 12 个；
 *      三语言放同一页也方便核对译文是否同步（不同步时一眼看得出来）。
 * @why 没有基址就**不给地址**（整键省略）而不是给相对路径：相对路径复制到浏览器打不开（W-06），
 *      前端会落到"暂时没有可查看的条款"——比给一个坏链接诚实。
 * @why seller 只带已配置的字段：特商法要求的販売業者 / 代表者 / 所在地 / 電話 / メール在公司登记前填不了真值，
 *      编一个占位值出去比不显示更糟（会被当成真实信息）。
 * @limitation 文档种类写死四类（用户协议 / 隐私政策 / 退货政策 / 特商法表示）：新增一类要同时加静态页。
 * @see scripts/checkout-build-lib.ts（LEGAL_DOCS 同名常量，构建期）；app/product-routes.ts（GET /terms）
 */
export const LEGAL_DOCS = ['terms', 'privacy', 'refund', 'tokushoho'] as const;
export const LEGAL_LANGS = ['zh', 'ja', 'en'] as const;

export type LegalDoc = (typeof LEGAL_DOCS)[number];
export type LegalLinks = Record<(typeof LEGAL_LANGS)[number], string>;

export function legalLinks(base: string, doc: LegalDoc): LegalLinks {
  const root = base.replace(/\/+$/, '');
  return {
    zh: `${root}/legal/${doc}/#zh`,
    ja: `${root}/legal/${doc}/#ja`,
    en: `${root}/legal/${doc}/#en`,
  };
}

export function legalDocuments(base: string): Record<LegalDoc, LegalLinks> {
  return Object.fromEntries(LEGAL_DOCS.map((d) => [d, legalLinks(base, d)])) as Record<
    LegalDoc,
    LegalLinks
  >;
}

export interface SellerConfig {
  SELLER_NAME?: string | undefined;
  SELLER_REPRESENTATIVE?: string | undefined;
  SELLER_ADDRESS?: string | undefined;
  SELLER_PHONE?: string | undefined;
  SELLER_EMAIL?: string | undefined;
}

/** 已配置的商家字段（未配置的整键省略）。 */
export function sellerInfo(c: SellerConfig): Record<string, string> {
  const pairs: Array<[string, string | undefined]> = [
    ['name', c.SELLER_NAME],
    ['representative', c.SELLER_REPRESENTATIVE],
    ['address', c.SELLER_ADDRESS],
    ['phone', c.SELLER_PHONE],
    ['email', c.SELLER_EMAIL],
  ];
  return Object.fromEntries(pairs.filter((p): p is [string, string] => p[1] !== undefined));
}
