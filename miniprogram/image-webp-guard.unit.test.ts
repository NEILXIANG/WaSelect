/**
 * 职责：断言「所有 `<image>` 都必须显式开启 `webp` 属性」——否则商品图在真机上全白。
 *
 * @why 图片管线 100% 输出 webp（`server/src/adapters/image-resize.ts` 三档统一 webp，
 *      键形由 `server/src/domain/upload-image.ts` `imageObjectKey()` 钉死 `.webp` 后缀），
 *      而微信 `<image>` 组件的 `webp` 属性**默认是 false**——不显式打开，组件不解析 webp，
 *      表现是加载失败但 HTTP 是 200（`net::OK` + Failed to load image），
 *      日志与监控都看不出异常，**只有肉眼看见白图才知道**。
 *
 * @why 这条必须机器守着而不是写进文档：漏写与写对在代码上只差一个属性，
 *     而且失效形态是"静默白图"（与 D-46 同类：错了还静默）。
 *     历史上本仓库每一次较大规模缺陷集中暴露，都是因为纪律没有强制器。
 *
 * @measured 2026-10-12 微信开发者工具（macOS，基础库 3.17.3）实测：
 *      `wx.getImageInfo` 对 webp 三档变体（64×64 有损 / 64×64 无损 / 300×300 有损）**全部失败**，
 *      对 png（同服务器同目录、同为 200 与正确 Content-Type）成功。
 *      排除 Content-Type、CSP、网络因素后，结论是格式未被解析。
 *      真机支持情况**未实测**（无真机预览条件），依据：微信官方 image 组件文档
 *      「webp 布尔值，默认 false；基础库 2.9.0 起配置 webp 为 true 时 iOS 支持」。
 *
 * @limitation 一：只做**形态级**匹配（`<image` 开标签内含 `webp=`），不是 AST。
 *              属性写成 `webp="{{true}}"` 与 `webp="true"` 都算通过；写成 `webp` 无值不算
 *              （WXML 里无值布尔属性解析行为不明确，统一要求带值）。
 * @limitation 二：本地 assets 的 png 占位图其实不需要 webp 属性，但规则不做区分——
 *              区分要靠"这个 src 是不是 webp"，而 src 多为运行时变量，静态扫不出来。
 *              统一打开没有副作用（属性只是"允许解析 webp"）。
 *
 * @see ./components/ws-pick-card/index.wxml（商品图组件）；
 *      docs/自主决策记录.md（本次修复需登记）
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
 *      排在它后面的 `webp` 属性被切掉 → 已修好的标签被误报成违规）。
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

/** 找出没有开 webp 的 `<image>`。 */
function findImagesWithoutWebp(wxml: string): string[] {
  return imageTags(stripComments(wxml)).filter((tag) => !/\bwebp\s*=/.test(tag));
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

describe('<image> 必须显式开启 webp 属性（图片管线只产 webp）', () => {
  it('扫描范围非空，且含真实用到商品图的文件（否则下面几条是假绿灯）', () => {
    // @why 与 storage-guard / page-button-guard 同源：目录改名或过滤写错会让列表变空，
    //      "没有违规"就永远成立。钉住"必须有那个真的会踩这条规则的文件"。
    expect(wxmlFiles).toContain('miniprogram/components/ws-pick-card/index.wxml');
    expect(wxmlFiles).toContain('miniprogram/pages/home/index.wxml');
    expect(wxmlFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('所有 <image> 都带 webp 属性（漏一个 = 该处商品图在真机上是白图）', () => {
    const offenders = wxmlFiles.flatMap((rel) =>
      findImagesWithoutWebp(readFileSync(join(root, rel), 'utf8')).map(
        (tag) => `${rel}  <image${tag}>`,
      ),
    );
    expect(
      offenders,
      `以下 <image> 没开 webp——图片管线只产 webp，这些位置在真机上是白图且不会报错：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('匹配器自检：扫得出漏写的、放得过已开与注释', () => {
    // @why 形态级正则最可能坏的两处：漏报（真漏写没扫到）与误报（注释被算违规）。
    //      少了这一条，写坏的正则会永远绿——而"永远绿"和"真的干净"看起来一模一样。
    const sample = [
      '<image class="a" src="{{item.image}}" mode="aspectFill" />', // 1：漏写 → 要抓
      '<image class="b" src="{{x}}" webp="{{true}}" mode="aspectFill" />', // 已开 → 放过
      '<image class="c" src="{{y}}" webp="true" lazy-load />', // 已开（字符串值）→ 放过
      '<!-- <image class="d" src="{{z}}" /> -->', // 注释 → 放过
      '<image class="e" src="{{w}}" webp="{{true}}" />', // 已开 → 放过
    ];
    expect(findImagesWithoutWebp(sample.join('\n'))).toHaveLength(1);
  });
});
