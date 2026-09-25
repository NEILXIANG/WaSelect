/**
 * 职责：design token 的**门禁**（F14 第三单元）——页面样式不得写死色值与尺寸，且不得引用未定义的 token。
 *
 * @why app.wxss 里已经有一套 `--ws-*` 变量，但"有 token"和"用 token"是两件事。
 *      写死的表现是**改版时逐页改**：今天把主色改一遍要动 N 个页面，漏掉的那个页面
 *      会保留旧色，而且没人能从代码上发现"还有一页没改"——它看起来完全正常。
 *      这是"UI 不写死"这条要求的落地方式，也是唯一能让它不靠 review 记得的手段。
 *
 * @why 还要反向断言"用到的 token 都被定义过"：
 *      `var(--ws-color-typo)` 写错一个字母时，CSS **不报错**，只是那条样式静默失效——
 *      表现是"这个元素的颜色不对"，而排查方向会去看选择器、看层级，不会去查拼写。
 *      这类失效和写死值一样贵，但更隐蔽。
 *
 * @how 纯 fs + 正则（不跑 ESLint）：CSS 不在 ESLint 的默认解析范围里，
 *      为一个 4 条断言的检查引入 CSS parser 不划算；代价是**要自己处理注释**——
 *      不剥注释的话，注释里举的反例（`#fff`）会把自己扫成违规（见 @limitation 一）。
 *
 * @limitation 一：只剥 `/* … *\/` 块注释，不剥 `//`（CSS 没有行注释）。
 * @limitation 二：**不覆盖颜色关键字**（`white` / `red`…）。它们与类名、属性名同形
 *              （`.btn-white`），精确识别要真解析 CSS；当前只拦"冒号后紧跟关键字"这一种形态，
 *              其余留给 review。这是已知覆盖缺口，不是漏配。
 * @limitation 三：**不覆盖百分比 / em / vh**（`50%` / `100vh`）。
 *              它们是**相对量**，写死不构成"改版要逐页改"的问题——
 *              百分比随容器变，`24rpx` 不随任何东西变。
 * @limitation 四：`0` 允许（`margin: 0` 没有 token 的意义，加一个 `--ws-zero` 是噪音）。
 *
 * @see ../app.wxss（token 定义处，唯一真源）；docs/地基搭建清单.md F14；CLAUDE.md 约束五
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
/** token 定义处：**它是唯一允许出现字面量**的样式文件。 */
const TOKEN_FILE = 'miniprogram/app.wxss';

/** 递归列出某个根下的所有 `.wxss`。 */
function listWxss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listWxss(full, out);
    else if (entry.name.endsWith('.wxss')) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

const MINIPROGRAM = join(root, 'miniprogram');
const allWxss = listWxss(MINIPROGRAM);
/** 页面 / 组件样式：受约束的部分。 */
const pageWxss = allWxss.filter((f) => f !== TOKEN_FILE);

/** 剥掉块注释——否则注释里举的反例会把自己扫成违规。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 硬编码色值：#rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / hsla() */
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const COLOR_FN = /\b(?:rgba?|hsla?)\s*\(/g;
/** 冒号后紧跟颜色关键字（@see @limitation 二：只拦这一种形态）。 */
const NAMED_COLOR =
  /:\s*(?:red|green|blue|black|white|gray|grey|yellow|orange|purple|pink|brown|cyan|magenta)\b/g;

/** 尺寸字面量：非 0 的 rpx / px（@see @limitation 三、四）。 */
function sizeLiterals(css: string): string[] {
  const hits: string[] = [];
  for (const m of css.matchAll(/(\d*\.?\d+)(rpx|px)\b/g)) {
    const n = Number(m[1]);
    if (n !== 0) hits.push(m[0]);
  }
  return hits;
}

/** 某个文件里的全部违规（空数组 = 干净）。 */
function violations(css: string): string[] {
  const body = stripComments(css);
  return [
    ...(body.match(HEX) ?? []).map((s) => `色值 ${s}`),
    ...(body.match(COLOR_FN) ?? []).map((s) => `色值函数 ${s.trim()}`),
    ...(body.match(NAMED_COLOR) ?? []).map((s) => `颜色关键字 ${s.trim()}`),
    ...sizeLiterals(body).map((s) => `尺寸 ${s}`),
  ];
}

/** app.wxss 里定义过的 token 名（如 `--ws-color-bg`）。 */
function definedTokens(css: string): Set<string> {
  return new Set([...stripComments(css).matchAll(/(--ws-[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? ''));
}

describe('扫描范围（空扫描会让下面所有断言变成假绿灯）', () => {
  it('小程序目录下至少扫到 2 个 wxss，且页面样式不为空', () => {
    // @why §2 第 6 条的教训：扫描脚本自己有 bug 时表现为"全绿"。
    //      这条保证"确实扫到了东西"，否则下面每条断言都会因为集合为空而通过。
    expect(allWxss.length, 'miniprogram 下连一个 wxss 都没扫到——路径写错了？').toBeGreaterThan(1);
    expect(pageWxss.length, '除 app.wxss 之外没有页面样式——是不是目录被搬走了？').toBeGreaterThan(
      0,
    );
  });

  it('匹配器自检：故意写死的样式必须被扫出来（反过来 = 匹配器坏了）', () => {
    const dirty = '.a { color: #ffffff; margin: 12rpx; border: 1px solid rgb(1,2,3); }';
    const found = violations(dirty);
    expect(found).toContain('色值 #ffffff');
    expect(found).toContain('尺寸 12rpx');
    expect(found).toContain('尺寸 1px');
    expect(found.some((s) => s.startsWith('色值函数'))).toBe(true);

    // 反例：干净的样式不该被扫出任何东西（否则门禁会逼人写不可能通过的代码）
    expect(violations('.a { color: var(--ws-color-fg); margin: 0; padding: 50%; }')).toEqual([]);
    // 反例：注释里的反例不算违规（这正是要剥注释的原因）
    expect(violations('/* 反例：#fff 与 12rpx */\n.a { color: var(--x); }')).toEqual([]);
  });
});

describe('页面样式不得写死（约束五：UI 不写死）', () => {
  it('除 app.wxss 外的每个 wxss 都没有硬编码色值 / 尺寸字面量', () => {
    const offenders = pageWxss.flatMap((rel) => {
      const found = violations(readFileSync(join(root, rel), 'utf8'));
      return found.length === 0 ? [] : [`${rel}：${found.join('、')}`];
    });
    expect(
      offenders,
      `页面样式写死了值（改版时要逐页改，漏掉的那页会静默保留旧样式）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('用到的每一个 `--ws-*` token 都在 app.wxss 里定义过（拼错 = 静默失效）', () => {
    const defined = definedTokens(readFileSync(join(root, TOKEN_FILE), 'utf8'));
    expect(defined.size, 'app.wxss 里一个 token 都没解析出来——命名前缀改了？').toBeGreaterThan(0);

    const dangling = pageWxss.flatMap((rel) => {
      const used = [
        ...stripComments(readFileSync(join(root, rel), 'utf8')).matchAll(
          /var\(\s*(--ws-[a-z0-9-]+)/g,
        ),
      ].map((m) => m[1] ?? '');
      return used.filter((t) => !defined.has(t)).map((t) => `${rel} 用了未定义的 ${t}`);
    });
    expect(dangling, `token 拼错不会报错，只是那条样式静默失效：\n${dangling.join('\n')}`).toEqual(
      [],
    );
  });
});

describe('token 定义处的 hygiene', () => {
  it('app.wxss 自己**确实**在写字面量（它是唯一被豁免的文件，豁免必须有理由）', () => {
    // @why 与上一条成对：只测"页面不许写死"会被一条"把所有文件都加进豁免"的改动骗过。
    //      这里证明豁免是**有条件的**（因为 token 必须在某处被定义成真实值），不是偷懒。
    const css = readFileSync(join(root, TOKEN_FILE), 'utf8');
    expect(
      violations(css).length,
      'app.wxss 里一个字面量都没有——token 在哪定义的？',
    ).toBeGreaterThan(0);
  });

  it('app.wxss 存在（packOptions 没有把它排除掉）', () => {
    expect(statSync(join(root, TOKEN_FILE)).isFile()).toBe(true);
  });
});
