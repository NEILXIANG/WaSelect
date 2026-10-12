/**
 * 职责：断言「自定义组件标签上不写 class」（统一结论操作律 2）——要给组件定位 / 留白，包一层 `<view>` 把类写在 view 上。
 *
 * @why 类名写到组件标签上**会**落到组件的宿主节点，但宿主节点默认 `display: inline`：
 *      inline 上的 padding 包不住组件里的块级内容、上下 margin 不参与布局、width / min-width 不生效。
 *      @measured: 开发者工具自动化 `Element.getStyles` / `getOffset`（2026-10-09）：
 *        法务页 `<ws-section-head class="ws-gutter …">` → display=inline、padding-left=16px，标题 left=0（贴边，留白无效）；
 *        售后页把同一个类写在外层 `<view>` 上 → display=block、padding-left=16px（生效）；
 *        首页 `<ws-pick-card class="home__pick">` → display=inline、margin-top=29px（inline 上下外边距不参与布局）；
 *        首页 `<ws-button class="home__go">` → display=block（它是 flex 子项，被块化）、margin-left=6px 生效。
 *      同一个类写在两种位置上一个生效一个不生效，而看 WXML 看不出区别——只能机器守。
 * @why 按**多行**解析：此前修过 4 页，都是手查的单行写法；法务页的标签跨了 5 行，于是漏了（统一结论 5.3）。
 * @why 组件名取自 `usingComponents`（app.json + 各页 / 组件 json），不按 `ws-` 前缀猜：以后引入别的组件也覆盖得到。
 * @limitation 一：只看 `class=`，不看 `style=`（行内样式同样落在 inline 宿主上，但当前没有用法；出现时再加）。
 * @limitation 二：标签边界用「下一个 `>`」判定，属性值里出现 `>`（如 `{{a > b}}`）会切错——当前没有。
 * @limitation 三：豁免是名单式的，每条写明为什么在那个位置上确实生效 / 不影响；改了标签位置或类名就要重新判断。
 * @see pages/after-sale/index.wxml（包一层 view 的写法）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const MP = resolve(import.meta.dirname);

/**
 * 豁免：`文件:组件:类名` → 原因。
 * @why 原因必须能被复查：写"它在 flex 容器里"就要真的在 flex 容器里（@measured 见文件头）。
 */
const EXEMPT: Record<string, string> = {
  'components/ws-state-block/index.wxml:ws-button:ws-state__action':
    '读码：父级 .ws-state__actions 是 flex 列（display:flex; flex-direction:column），子项被块化，min-width 生效（未在模拟器实测）',
  'pages/index/index.wxml:ws-button:btn':
    '行走骨架停用页，未在 app.json 登记；`.btn` 也没有样式规则',
};

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p, ext);
    return p.endsWith(ext) ? [p] : [];
  });
}

/** 所有 json 里登记过的自定义组件标签名。 */
function componentTags(): Set<string> {
  const tags = new Set<string>();
  const jsons = [
    join(MP, 'app.json'),
    ...walk(join(MP, 'pages'), '.json'),
    ...walk(join(MP, 'components'), '.json'),
  ];
  for (const f of jsons) {
    if (!existsSync(f)) continue;
    const using = (
      JSON.parse(readFileSync(f, 'utf8')) as { usingComponents?: Record<string, string> }
    ).usingComponents;
    for (const name of Object.keys(using ?? {})) tags.add(name);
  }
  return tags;
}

/** 找出组件标签上的 class（跨行解析，先剥注释）。返回 `文件:组件:类名`。 */
export function findComponentClasses(rel: string, wxml: string, tags: Set<string>): string[] {
  const src = wxml.replace(/<!--[\s\S]*?-->/g, '');
  const out: string[] = [];
  for (const m of src.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/g)) {
    const tag = m[1] ?? '';
    if (!tags.has(tag)) continue;
    const cls = /(?:^|\s)class\s*=\s*"([^"]*)"/.exec(m[2] ?? '')?.[1];
    if (cls === undefined) continue;
    for (const c of cls.split(/\s+/).filter((x) => x !== '')) out.push(`${rel}:${tag}:${c}`);
  }
  return out;
}

describe('自定义组件标签上不写 class（操作律 2）', () => {
  const tags = componentTags();
  const found = [
    ...walk(join(MP, 'pages'), '.wxml'),
    ...walk(join(MP, 'components'), '.wxml'),
  ].flatMap((f) =>
    findComponentClasses(relative(MP, f).split(sep).join('/'), readFileSync(f, 'utf8'), tags),
  );

  it('🔴 除豁免名单外，没有任何组件标签带 class（要定位 / 留白请包一层 view）', () => {
    expect(found.filter((k) => EXEMPT[k] === undefined)).toEqual([]);
  });

  it('豁免名单里的每一条都还在（标签或类名改了就删掉豁免，别留空头支票）', () => {
    expect(Object.keys(EXEMPT).filter((k) => !found.includes(k))).toEqual([]);
  });

  it('自检：跨行标签、注释里的写法、非组件标签', () => {
    const t = new Set(['ws-section-head']);
    const wxml = `<!-- <ws-section-head class="in-comment" /> -->
<ws-section-head
  class="ws-gutter legal__head"
  title="x"
/>
<view class="ws-gutter"><ws-section-head title="y" /></view>`;
    expect(findComponentClasses('a.wxml', wxml, t)).toEqual([
      'a.wxml:ws-section-head:ws-gutter',
      'a.wxml:ws-section-head:legal__head',
    ]);
  });

  it('组件名真的取到了（防止 json 读空后全绿）', () => {
    expect(tags.has('ws-section-head')).toBe(true);
    expect(tags.has('ws-button')).toBe(true);
  });
});

/**
 * WXML 属性里不写 HTML 实体（统一结论 5.3 走查附带发现）。
 * @measured: 法务页 `kicker="Terms &amp; Policies"` 在模拟器里原样显示成"TERMS &AMP; POLICIES"；
 *            改成裸 `&` 后显示"TERMS & POLICIES"（2026-10-09 截图）。
 * @limitation 只查属性值（文本节点里的实体未实测，当前也没有用法）。
 */
export function findAttrEntities(rel: string, wxml: string): string[] {
  const src = wxml.replace(/<!--[\s\S]*?-->/g, '');
  const out: string[] = [];
  for (const m of src.matchAll(/\b([a-zA-Z:-]+)="([^"]*&(?:amp|lt|gt|quot|apos|#\d+);[^"]*)"/g)) {
    out.push(`${rel}:${m[1] ?? ''}`);
  }
  return out;
}

describe('WXML 属性里不写 HTML 实体', () => {
  it('🔴 所有页面与组件的 WXML 属性值里没有 &amp; / &lt; 等实体', () => {
    const found = [
      ...walk(join(MP, 'pages'), '.wxml'),
      ...walk(join(MP, 'components'), '.wxml'),
    ].flatMap((f) =>
      findAttrEntities(relative(MP, f).split(sep).join('/'), readFileSync(f, 'utf8')),
    );
    expect(found).toEqual([]);
  });

  it('自检：属性里的实体抓得到，注释里的不算', () => {
    expect(
      findAttrEntities('a.wxml', '<!-- k="a &amp; b" --><x kicker="Terms &amp; Policies" />'),
    ).toEqual(['a.wxml:kicker']);
  });
});
