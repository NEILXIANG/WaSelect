/**
 * 职责：断言**组件样板页登记了每一个已建组件**（F14 第九单元的守卫）。
 *
 * @why 组件级测试（simulate）钉的是结构与文案，钉不住**视觉**——
 *      后者只能靠人在真机上看一眼（L4）。而"看一眼"要成立，前提是
 *      **样板页上真的有这个组件**：新建一个组件却忘了登记，
 *      它就不会出现在验收面上，于是"这个组件长什么样"从此没人看过，
 *      而且**没有任何东西报错**——它的组件测试照样全绿。
 *      这正是"新增的东西悄悄脱离了防线"那一类失效。
 *
 * @why 顺带验"登记的路径真的存在"：`usingComponents` 里写错路径时，
 *      开发者工具的报错不指向具体行（表现为"组件渲染不出来"），排查成本很高；
 *      这里直接断言三件套齐备，把"路径写错"变成一条明确的红灯。
 *
 * @how 纯 fs + JSON 解析：这里是**跨文件的一致性检查**，不是逻辑测试，
 *      不需要跑任何小程序运行时。三层递进，任何一层漏了都有下一层兜住：
 *      ① 登记了 ② 路径存在 ③ wxml 里真的用了一次。
 *
 * @limitation 一：只验"用了 ≥1 次"，**不验**每种状态都摆出来了（loading / disabled /
 *              各档尺寸……）。状态清单会随组件演进，让机器去穷举等于把"写样板页"
 *              这件事再写一遍；这一层留给 L4 人工看。
 * @limitation 二：组件目录名与标签名**当前同名**（`ws-price` → `<ws-price>`）。
 *              若将来出现"目录名 ≠ 标签名"的组件，这里会误报，需要按映射表改。
 * @limitation 三：`app.json` 的 `pages[0]` 是启动页，所以样板页**不能排第一**；
 *              这里只挡"排第一"，不挡"样板页被打进发布包"（小程序没有条件编译页，
 *              @tradeoff 想彻底不带，得把它挪进分包并在提审前删——当前包体代价 ≈ 0，先不做）。
 *
 * @see ../pages/comp/index.json（样板页登记处）；docs/地基搭建清单.md F14
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 仓库根（本文件在 miniprogram/ 下，向上一层）。 */
const root = resolve(import.meta.dirname, '..');
/** 小程序根：`usingComponents` 里以 `/` 开头的路径就是相对它解析的。 */
const mini = join(root, 'miniprogram');
/** 相对小程序根的路径，与 `usingComponents` 的写法保持同一种语义。 */
const COMPONENTS_DIR = 'components';
const SHOWCASE_JSON = 'pages/comp/index.json';
const APP_JSON = 'app.json';
/** app.json 的 pages 里写的是不带 `miniprogram/` 前缀的页面路径。 */
const SHOWCASE_PAGE = 'pages/comp/index';

/** 列出 components 下的**目录名**（每个目录就是一个组件）。 */
function componentDirs(): string[] {
  const dir = join(mini, COMPONENTS_DIR);
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** 样板页声明的自定义组件（标签名 → 路径）。 */
function showcaseUsing(): Record<string, string> {
  const raw = readFileSync(join(mini, SHOWCASE_JSON), 'utf8');
  const json = JSON.parse(raw) as { usingComponents?: Record<string, string> };
  return json.usingComponents ?? {};
}

/** 在 `registered` 里找不到的组件目录名。 */
function missingFrom(dirs: readonly string[], registered: Record<string, string>): string[] {
  return dirs.filter((d) => !Object.values(registered).some((p) => p.endsWith(`/${d}/index`)));
}

describe('组件样板页必须登记每一个已建组件', () => {
  it('扫描范围非空，且含两个已建组件（否则下面几条会集体变成假绿灯）', () => {
    const dirs = componentDirs();
    expect(dirs.length, 'components 目录是空的——目录改名了？').toBeGreaterThan(0);
    expect(dirs).toContain('ws-price');
    expect(dirs).toContain('ws-button');
  });

  it('每个组件目录都被登记（新增组件必须同时登记，否则 L4 永远看不到它）', () => {
    const missing = missingFrom(componentDirs(), showcaseUsing());
    expect(
      missing,
      `这些组件没登记进 ${SHOWCASE_JSON}：${missing.join('、')}——` +
        `它们不会出现在样板页上，于是没人会在真机上看过它们长什么样`,
    ).toEqual([]);
  });

  it('登记的路径真实存在（三件套齐备；写错路径在工具里的报错不指向行）', () => {
    for (const [tag, rel] of Object.entries(showcaseUsing())) {
      // 路径以 `/` 开头 = 相对小程序根；去掉前导斜杠后到磁盘上找
      const abs = join(mini, rel.replace(/^\//, ''));
      for (const ext of ['.js', '.json', '.wxml']) {
        expect(existsSync(`${abs}${ext}`), `组件 ${tag} 缺少 ${rel}${ext}`).toBe(true);
      }
    }
  });

  it('样板页在 app.json 的 pages 里（不在就打不开，等于没有验收面）', () => {
    const app = JSON.parse(readFileSync(join(mini, APP_JSON), 'utf8')) as { pages: string[] };
    expect(app.pages).toContain(SHOWCASE_PAGE);
  });

  it('样板页不是启动页（pages[0] 是启动页；排第一就等于产品首页被顶掉）', () => {
    const app = JSON.parse(readFileSync(join(mini, APP_JSON), 'utf8')) as { pages: string[] };
    expect(app.pages[0], `启动页是 ${SHOWCASE_PAGE}——样板页不能排第一`).not.toBe(SHOWCASE_PAGE);
  });

  it('每个登记的组件在样板页 wxml 里至少用了一次（防"登记了但没摆出来"）', () => {
    const wxml = readFileSync(join(mini, 'pages/comp/index.wxml'), 'utf8');
    for (const tag of Object.keys(showcaseUsing())) {
      const used = wxml.split(`<${tag}`).length - 1;
      expect(used, `组件 ${tag} 登记了，但样板页 wxml 里一次都没用`).toBeGreaterThan(0);
    }
  });

  it('自检：登记缺一个时，检查函数真的会报出来（防"扫描写坏 → 永远绿"）', () => {
    // @why 与 §2 第 30 条同源：扫描型门禁最危险的失效是**假阴性**。
    //      这一条保证"上面那条断言"本身是有牙的。
    expect(
      missingFrom(['ws-price', 'ws-button'], { 'ws-price': '/components/ws-price/index' }),
    ).toEqual(['ws-button']);
    expect(missingFrom(['ws-price'], { 'ws-price': '/components/ws-price/index' })).toEqual([]);
  });
});
