/**
 * 职责：断言「页面不得自己实现连点防线」——可点的按钮必须走 `ws-button`（F14 第十单元的守卫）。
 *
 * @why 连点这道防线有两个可能的落点：页面方法开头手写一行 `if (loading) return;`，
 *      或者收进按钮组件里。两种写法**在页面上看起来完全一样**（都是点了没反应），
 *      区别只在失效形态：放两处时，只要有一处被改掉/漏写，就没有任何信号——
 *      不报错、不红、只是用户连点建出两张单。所以"只有一处"这件事必须机器守着，
 *      不能靠"写组件文档时说一句"。
 *
 * @why 与 `ws-button` 的组件测试不重复：组件测试钉的是"组件自己吞不吞点击"，
 *      这里钉的是"页面有没有绕开组件"。**组件是对的 + 页面没用它 = 防线仍然没有**，
 *      而这组合不会让任何一条组件测试变红。
 *
 * @how 纯 fs + 正则（与 `storage-guard` / `design-token` 同套路）：
 *      先剥注释再匹配，避免"注释里解释这条规则"被当成违规。
 *
 * @limitation 一：手写守卫的匹配是**形态级**的（一个 `if` 里出现 `this.data.loading` 然后 `return`），
 *              不是 AST 级。写成两行（`const busy = this.data.loading; if (busy) return;`）扫不到。
 *              @why 精确识别要引解析器，而这条规则的真实威胁是"照抄原来那一行"，
 *              形态级足够；真出现绕过时再升级。
 * @limitation 二：剥注释是正则做的，`//` 出现在字符串里（例如 URL）会被误当成注释起点。
 *              当前页面里没有；出现时改用真正的词法分析。
 * @limitation 三：原生 `<button>` 带 `open-type` / `form-type` 时**豁免**——
 *              那是微信托管行为的按钮（登录、客服、表单提交），换成自定义组件就没了原生能力。
 *              豁免是名单式的，不是"看起来特殊就放过"。
 * @limitation 四：`<button ...>` 标签的边界用「下一个 `>`」判定，
 *              属性值里出现 `>` 会切错。当前没有；属于 @limitation 一同级的简化。
 *
 * @see ./components/ws-button/index.js（防线唯一落点）；./pages/index/index.js @limitation 四；
 *      docs/自主决策记录.md AJ-74
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const PAGES_DIR = 'miniprogram/pages';

/** 页面 js 里"手写连点守卫"的形态。@see @limitation 一 */
const HAND_GUARD = /if\s*\([^;{}]*this\.data\.loading[^;{}]*\)\s*return/;

/** 原生按钮上的点击绑定（`bindtap` / `bind:tap` / `catchtap` / `catch:tap`）。 */
const TAP_BINDING = /\b(?:bind|catch):?tap\s*=/;

/** 微信托管行为的按钮：它们不能换成自定义组件。@see @limitation 三 */
const WECHAT_HOSTED = /\b(?:open|form)-type\s*=/;

/** 剥掉块注释与行注释。@see @limitation 二 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** 找出页面里手写的连点守卫（返回命中的原始行，便于报错时直接看）。 */
function findHandGuards(src: string): string[] {
  return stripComments(src)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => HAND_GUARD.test(line));
}

/** 取出 wxml 里所有原生 `<button ...>` 开标签的属性部分。@see @limitation 四 */
function buttonTags(wxml: string): string[] {
  return wxml
    .split('<button')
    .slice(1)
    .map((rest) => {
      const end = rest.indexOf('>');
      return end < 0 ? rest : rest.slice(0, end);
    });
}

/** 找出"可点且非微信托管"的原生按钮——这些必须换成 ws-button。 */
function findNativeTapButtons(wxml: string): string[] {
  return buttonTags(stripComments(wxml)).filter(
    (tag) => TAP_BINDING.test(tag) && !WECHAT_HOSTED.test(tag),
  );
}

function listPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listPages(full, out);
    else if (/\.(js|wxml)$/.test(entry.name)) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

const pages = listPages(join(root, PAGES_DIR)).sort();
const jsPages = pages.filter((f) => f.endsWith('.js'));
const wxmlPages = pages.filter((f) => f.endsWith('.wxml'));

describe('页面不得自己实现连点防线（可点按钮统一走 ws-button）', () => {
  it('扫描范围非空，且含骨架页的 js 与 wxml（否则下面几条是假绿灯）', () => {
    // @why 与 storage-guard 同源：目录改名 / 过滤写错会让列表变空，
    //      "没有违规"就永远成立。钉住"必须有那个真的会踩这条规则的文件"。
    expect(jsPages).toContain('miniprogram/pages/index/index.js');
    expect(wxmlPages).toContain('miniprogram/pages/index/index.wxml');
    expect(pages.length).toBeGreaterThanOrEqual(4);
  });

  it('页面 js 里没有手写的连点守卫（防线只在 ws-button 里有一份）', () => {
    const offenders = jsPages.flatMap((rel) =>
      findHandGuards(readFileSync(join(root, rel), 'utf8')).map((line) => `${rel}  ${line}`),
    );
    expect(
      offenders,
      `页面自己挡了连点——防线变成两处，其中一处迟早被改掉：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('页面 wxml 里没有"可点的原生 button"（open-type / form-type 豁免）', () => {
    const offenders = wxmlPages.flatMap((rel) =>
      findNativeTapButtons(readFileSync(join(root, rel), 'utf8')).map(
        (tag) => `${rel}  <button${tag}>`,
      ),
    );
    expect(
      offenders,
      `原生 button 不自带连点防线（loading 只转圈、不挡点击）——换成 ws-button：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('匹配器自检：手写守卫扫得出真的、放得过注释与非守卫用法', () => {
    // @why 形态级正则最可能坏的两种形态：**漏报**（真守卫没扫到）与**误报**（注释被算违规）。
    //      少了这一条，写坏的正则会永远绿——而"永远绿"和"真的干净"看起来一模一样。
    const sample = [
      '    if (this.data.loading) return;', // 1：真守卫
      '    if (!this.data.loading) return;', // 2：反向写法，同样是守卫
      '    console.log(this.data.loading);', // 只是读取，不是守卫 → 不算
      '    // if (this.data.loading) return;', // 注释里解释这条规则 → 不算
      '    this.setData({ loading: false });', // 写状态 → 不算
    ];
    expect(findHandGuards(sample.join('\n'))).toHaveLength(2);
  });

  it('匹配器自检：原生按钮只抓"可点且非托管"的，豁免两类', () => {
    const sample = [
      '<button class="btn" bindtap="onCreate">建单</button>', // 1：要抓
      '<button open-type="getPhoneNumber" bindtap="onPhone">授权</button>', // 托管 → 豁免
      '<button form-type="submit">提交</button>', // 托管 → 豁免
      '<ws-button text="建单" bindtap="onCreate" />', // 已经是组件 → 不算
      '<button class="btn">只是装饰</button>', // 不可点 → 不算
    ];
    expect(findNativeTapButtons(sample.join('\n'))).toHaveLength(1);
  });
});
