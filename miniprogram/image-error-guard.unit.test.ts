/**
 * 职责：断言「所有 `<image>` 都必须带 `binderror`」——否则图加载失败时真机上留一个破图占位。
 *
 * @why 图片全部来自远端（图床 / CDN），失败是**常态**不是异常：CDN 404、域名没在
 *      小程序后台登记 downloadFile 合法域名、运营把图删了——三种都不报错，
 *      `<image>` 只是静静地在那一格留一个破图图标。用户看到的是"这个商品坏了"，
 *      而我们要他看到的是"这一件暂时没图"（`.ws-media` 自带底色，收起 `<image>` 即是）。
 *
 * @why 这条必须机器守着：漏写与写对在代码上只差一个属性，而失效形态是"静默破图"
 *      ——与 `image-webp-guard` 那条同源（错了还静默），只有肉眼看得见。
 *      把它留给 code review 的结果是每一位新加图的人都要重新想起这件事一次。
 *
 * @limitation 一：只做**形态级**匹配（`<image` 开标签内含 `binderror=`），不是 AST。
 *              它不检查"标记是不是按项记的"——列表场景写成整页一个布尔值同样能过本守卫，
 *              那条由各页自己的单测钉（例：`pages/order-detail/index.wxml.unit.test.ts`）。
 *              收不住它的原因：判断"是不是按项"要读 `wx:if` 里有没有 `[index]`，
 *              而单图场景**本来就该**是整页一个布尔值——形态上无法区分这两种合法写法。
 * @limitation 二：**没有**为"静态本地资源"开口子——本仓 `pages/` 与 `components/` 里
 *              目前没有任何 `<image>` 指向包内 `/assets/...`（`utils/placeholder.js` 的
 *              `PLACEHOLDER_IMAGE` 是本地文件，但它只作为**运行时**的 src 值出现，
 *              静态扫不出来）。真出现了也不必豁免：本地图不会失败，`binderror` 永不触发，
 *              带上它没有副作用——而"开口子"要有白名单，白名单是要人维护的第二份真源。
 *
 * @see ./image-webp-guard.unit.test.ts（同形态的姊妹守卫：webp 必须显式开）；
 *      ./utils/image-failed.js（失败标记的唯一算法）；
 *      ./components/ws-pick-card/index.wxml:15（单图场景的范例）
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['miniprogram/pages', 'miniprogram/components'];

/**
 * wxml 里 `<image ...>` 开标签的属性部分。@see @limitation 一
 *
 * @why 标签边界不能简单取「第一个 `>`」：属性值里合法地出现 `>` 会把它切错
 *      （实测 `lazy-load="{{index > 0}}"` 就在 `index >` 处截断，
 *      排在它后面的属性被切掉 → 已写好的标签被误报成违规）。
 *      属性值的 `>` 一定在引号内，所以按引号状态机找**不在引号内**的 `>`。
 * @measured 2026-10-12 `miniprogram/pages/detail/index.wxml` 画廊标签实测触发此误报。
 */
function imageTags(wxml: string): string[] {
  return wxml
    .split('<image')
    .slice(1)
    .map((rest) => {
      let inQuote = false;
      for (let i = 0; i < rest.length; i += 1) {
        const ch = rest[i];
        if (ch === '"') inQuote = !inQuote;
        else if (ch === '>' && !inQuote) return rest.slice(0, i);
      }
      return rest;
    });
}

/** 剥掉注释，避免"注释里解释这条规则"被当成合规。 */
function stripComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

/** 找出没有 `binderror` 的 `<image>`。 */
function findImagesWithoutError(wxml: string): string[] {
  return imageTags(stripComments(wxml)).filter((tag) => !/\bbinderror\s*=/.test(tag));
}

function listWxml(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listWxml(full, out);
    else if (entry.name.endsWith('.wxml')) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

const wxmlFiles = SCAN_DIRS.flatMap((d) => listWxml(join(root, d))).sort();

describe('<image> 必须带 binderror（图加载失败不能留破图）', () => {
  it('扫描范围非空，且含真实用到商品图的文件（否则下面几条是假绿灯）', () => {
    // @why 与 image-webp-guard / storage-guard 同源：目录改名或过滤写错会让列表变空，
    //      "没有违规"就永远成立。钉住"必须有那个真的会踩这条规则的文件"。
    expect(wxmlFiles).toContain('miniprogram/components/ws-pick-card/index.wxml');
    expect(wxmlFiles).toContain('miniprogram/pages/order-detail/index.wxml');
    expect(wxmlFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('所有 <image> 都带 binderror（漏一个 = 那一张图失败时真机上是破图）', () => {
    const offenders = wxmlFiles.flatMap((rel) =>
      findImagesWithoutError(readFileSync(join(root, rel), 'utf8')).map(
        (tag) => `${rel}  <image${tag}>`,
      ),
    );
    expect(
      offenders,
      `以下 <image> 没带 binderror——图取不到时真机上留破图占位，且不报错：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('匹配器自检：扫得出漏写的、放得过已绑与注释', () => {
    // @why 形态级正则最可能坏的两处：漏报（真漏写没扫到）与误报（注释被算违规）。
    //      少了这一条，写坏的正则会永远绿——而"永远绿"和"真的干净"看起来一模一样。
    const sample = [
      '<image class="a" src="{{item.image}}" mode="aspectFill" webp="{{true}}" />', // 1：漏写 → 要抓
      '<image class="b" src="{{x}}" binderror="onImgError" webp="{{true}}" />', // 已绑 → 放过
      '<image class="c" src="{{y}}" binderror="onGalleryError" data-index="{{index}}" />', // 已绑 → 放过
      '<!-- <image class="d" src="{{z}}" /> -->', // 注释 → 放过
      '<image class="e" src="{{w}}" lazy-load="{{index > 0}}" binderror="onImgError" />', // 属性里带 `>` 且已绑 → 放过
    ];
    expect(findImagesWithoutError(sample.join('\n'))).toHaveLength(1);
  });
});
