/**
 * 职责：结算页邮箱输入框——占位符样式（UX-012）、占位符长度（UX-013）、用途说明常驻（CPY-015）。
 *
 * @why 这三条都是"改对了和改错了在代码上只差一个属性 / 几个字"的缺陷，肉眼复核看不出来：
 *      ① `placeholder-class` 漏写或指向一个不存在的类，页面**不报错**——只是占位符掉回微信默认色，
 *         和买家真填进去的字同色同重，框里到底是"示例"还是"自己填的"一眼分不出；
 *      ② placeholder 超长时小程序不换行也不省略号，**直接把尾部截掉**（UX-013 实测：25 字 / 约 590rpx 可视宽），
 *         用户看到的是半句话，而不是一句被折行的话；
 *      ③ 用途说明一旦挂回 `emailError` 之类的空态变量，用户敲第一个字符它就消失——
 *         收集时告知的利用目的要与实际一致（APPI），**少说同样是不一致**（AJ-295 的定性口径）。
 * @why 本页此前是全仓少数几个没有 wxml 测试文件的页面之一，这三条改完没有任何机器守着；
 *      本仓库每一次较大规模缺陷集中暴露，都是因为纪律没有强制器。
 *
 * @limitation 只验模板文本（形态级），不验渲染；真实效果以模拟器截图为准。
 * @limitation 二：可用宽度按"屏宽 − 两侧留白 − 卡片内边距 − 输入框左右内边距"算，
 *               忽略了卡片 1rpx 边框（忽略它是**偏松**的一侧：真实可视宽还要再少 2rpx）。
 * @limitation 三：字符上限按"每个字符都占一个正方形字身（1em）"算，ASCII 实际更窄——
 *               也是偏松的一侧。取偏松是为了不把"半角多一点"误判成缺陷，
 *               真正要挡的是 25 字那种整段被截。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;

/** 剥掉注释：否则"注释里解释这条规则"会被当成合规。 */
const stripWxmlComments = (src: string): string => src.replace(/<!--[\s\S]*?-->/g, '');
const stripCssComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '');

const wxml = stripWxmlComments(readFileSync(resolve(dir, 'index.wxml'), 'utf8'));
const pageCss = stripCssComments(readFileSync(resolve(dir, 'index.wxss'), 'utf8'));
const appCss = stripCssComments(readFileSync(resolve(dir, '../../app.wxss'), 'utf8'));

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** 取标签上的某个属性值；没这个属性 → null（空串是有值，两者要分得开）。 */
function attr(tag: string, name: string): string | null {
  return new RegExp(`(?:^|\\s)${escapeRe(name)}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1] ?? null;
}

/** 取某个开标签（跨行；按 `>` 收尾——属性值里可能有 `>`）。 */
function tagByName(src: string, name: string, needle: string): string {
  return (
    (src.match(new RegExp(`<${escapeRe(name)}\\b[\\s\\S]*?>`, 'g')) ?? []).find((t) =>
      t.includes(needle),
    ) ?? ''
  );
}

/** 这段 CSS 里有没有真的定义 `.cls` 这条规则。 */
function definesClass(css: string, cls: string): boolean {
  return new RegExp(`(?:^|[,{\\s])\\.${escapeRe(cls)}\\s*(?=[,{])`, 'm').test(css);
}

/** 条件渲染属性：带上它就意味着"这个节点不一定在页面上"。 */
const CONDITIONAL = /\bwx:(?:if|elif|else|for)\s*=|\bhidden\s*=/;

/**
 * 读一条 CSS 声明并解成 rpx 数字（`var(--token)` 解一层）。
 * `part` 取简写的第几个值（`padding: A B` 的左右是第 1 个）。
 *
 * @why 占位符的字数上限必须**算出来**而不是拍出来：拍出来的数字没人知道它什么时候失效，
 *      算出来的会随 token 一起动，且这里读不到就抛错逼人重新推导。
 */
function rpx(css: string, selector: string, prop: string, part = 0): number {
  const block =
    new RegExp(`(?:^|[},])\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '';
  const raw = new RegExp(`${escapeRe(prop)}\\s*:\\s*([^;}]+)`).exec(block)?.[1]?.trim() ?? '';
  const parts = raw.split(/\s+/).filter((v) => v !== '');
  const value = parts[Math.min(part, parts.length - 1)] ?? '';
  const tokenName = /^var\(--([\w-]+)\)$/.exec(value)?.[1];
  const digits = tokenName
    ? new RegExp(`--${escapeRe(tokenName)}:\\s*(\\d+(?:\\.\\d+)?)rpx`).exec(appCss)?.[1]
    : /^(\d+(?:\.\d+)?)rpx$/.exec(value)?.[1];
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `推导占位符可用宽度失败：\`${selector}\` 的 \`${prop}\` 读不到 rpx 值（${
        raw || '空'
      }）。token 或选择器改名后请按同一口径重新推导，不要改用一个拍出来的数字。`,
    );
  }
  return n;
}

/** 微信小程序设计屏宽（rpx 的定义基准）。 */
const SCREEN_RPX = 750;
/** 输入框里一行能显示多宽：屏宽 − 两侧留白 − 卡片内边距 − 输入框左右内边距。 */
const VISIBLE_RPX =
  SCREEN_RPX -
  2 * rpx(appCss, '.ws-gutter', 'padding-left') -
  2 * rpx(appCss, '.ws-card', 'padding') -
  2 * rpx(pageCss, '.input', 'padding', 1);
/** 正文字号（一个字身 = 1em，@see @limitation 三）。 */
const CHAR_RPX = rpx(pageCss, '.input', 'font-size');
/** 单行放得下的最多字符数。 */
const MAX_PLACEHOLDER_CHARS = Math.floor(VISIBLE_RPX / CHAR_RPX);

const input = tagByName(wxml, 'input', 'onEmailInput');

describe('结算页：邮箱占位符（UX-012 样式 / UX-013 长度）', () => {
  it('🔴 取得到那个邮箱输入框（找不到就说明下面几条都是假绿灯）', () => {
    // @why 与 image-webp-guard 同源：选择器写错、`onEmailInput` 改名会让 `input` 变空串，
    //      后面 `attr()` 全返回 null——而"取不到"和"没有违规"看起来一模一样。
    expect(input, 'wxml 里找不到绑了 onEmailInput 的 <input>：是改名了还是整块被删了？').not.toBe(
      '',
    );
  });

  it('🔴 <input> 上写了 placeholder-class，且它指向的类在本页有定义', () => {
    const cls = attr(input, 'placeholder-class');
    expect(
      cls,
      `<input> 上没有 placeholder-class：占位符会掉回微信默认色，和买家真填进去的字同色同重，` +
        `框里到底是"示例"还是"自己已经填了"一眼分不出（UX-012 回归）。`,
    ).not.toBeNull();
    expect(
      cls,
      `placeholder-class 是空串——写了个属性等于没写，占位符照样是默认色（UX-012 回归）。`,
    ).not.toBe('');
    expect(
      definesClass(pageCss, String(cls)) || definesClass(appCss, String(cls)),
      `placeholder-class 指向的 \`.${String(cls)}\` 在 checkout/index.wxss 与 app.wxss 里都没有定义：\n` +
        `指向一个不存在的类等于没写，占位符与真填同色同重，而页面不会报任何错（UX-012 回归）。`,
    ).toBe(true);
  });

  it(`🔴 placeholder 文案不超过单行可视宽（≤ ${MAX_PLACEHOLDER_CHARS} 字）`, () => {
    const text = attr(input, 'placeholder');
    expect(text, '<input> 上没有 placeholder：整个框是空的，用户不知道该填什么。').not.toBeNull();
    const chars = [...String(text)].length;
    expect(
      chars,
      `placeholder 有 ${chars} 字，单行可视宽 ${VISIBLE_RPX}rpx ÷ 字身 ${CHAR_RPX}rpx 只放得下 ` +
        `${MAX_PLACEHOLDER_CHARS} 字：小程序对 placeholder 既不换行也不加省略号，超出部分**直接被截掉**——\n` +
        `用户看到的是一句被切掉尾巴的半句话（UX-013：这里曾经是 25 字，尾部"订单有问题时也用它联系你"全没了）。`,
    ).toBeLessThanOrEqual(MAX_PLACEHOLDER_CHARS);
  });

  it('自检：属性提取器与类名匹配器（防止永久绿灯）', () => {
    // @why 形态级匹配最可能坏的两处：漏报（真缺失没抓到）与误报（注释 / 近似类名算合规）。
    //      少了这一条，写坏的正则会永远绿——而"永远绿"和"真的合规"看起来一模一样。
    const bare =
      '<input class="input" placeholder="例：name@gmail.com" bindinput="onEmailInput" />';
    expect(attr(bare, 'placeholder-class')).toBeNull();
    expect(
      attr('<input placeholder-class="" bindinput="onEmailInput" />', 'placeholder-class'),
    ).toBe('');
    expect(definesClass('.ph { color: var(--ws-ink-faint); }', 'ph')).toBe(true);
    expect(definesClass('.photo { color: red; }', 'ph')).toBe(false); // 近似类名不算
    expect(definesClass(stripCssComments('/* .ph { color: red; } */'), 'ph')).toBe(false); // 注释里不算
  });

  it('自检：字数上限是从 token 算出来的，不是一个拍出来的数字', () => {
    // @why 上限若被人改成字面量，前面那条长度断言就失去了"为什么是这么多"的依据。
    //      钉住推导链条（可视宽与字身都 > 0，且可视宽确实只放得下这么多个字身）。
    expect(VISIBLE_RPX).toBeGreaterThan(CHAR_RPX);
    expect(MAX_PLACEHOLDER_CHARS * CHAR_RPX).toBeLessThanOrEqual(VISIBLE_RPX);
    expect((MAX_PLACEHOLDER_CHARS + 1) * CHAR_RPX).toBeGreaterThan(VISIBLE_RPX);
  });
});

describe('结算页：邮箱用途说明常驻（CPY-015）', () => {
  it('🔴 页面上有一行 field__purpose，且它是无条件渲染、不依赖任何空态变量', () => {
    const purpose = tagByName(wxml, 'text', 'field__purpose');
    expect(
      purpose,
      '页面上找不到 class 含 field__purpose 的 <text>：邮箱的用途说明又只剩 placeholder 和报错文案两处空态了——' +
        '买家一敲字它就消失，收集时告知的利用目的要与实际一致（APPI），少说同样是不一致（CPY-015 回归）。',
    ).not.toBe('');

    expect(
      CONDITIONAL.test(purpose),
      `用途说明这一行带了条件渲染属性：${purpose}\n` +
        '一旦挂回 emailError / email 这类空态变量，用户敲第一个字符它就消失，' +
        '"会用在哪"这条告知等于只在没填时说过一次（CPY-015 回归）。',
    ).toBe(false);

    const after = wxml.slice(wxml.indexOf(purpose) + purpose.length);
    const text = after.slice(0, after.indexOf('</text>'));
    expect(text, '用途说明这一行是空的：写了个常驻节点却没内容，等于告知还在、字没了。').not.toBe(
      '',
    );
    expect(/\{\{\s*email\w*\s*\}\}/.test(text), `用途说明的正文引用了空态变量：${text}`).toBe(
      false,
    );

    // 所在分区本身也得是无条件的：整块被包进 wx:if 的话，上面这几条全白钉。
    const section = tagByName(wxml, 'view', 'id="contact-email"');
    expect(section).not.toBe('');
    expect(
      CONDITIONAL.test(section),
      `邮箱这一整块（${section.trim()}）带了条件渲染：用途说明就算自己没挂 wx:if，整块不渲染时照样看不见。`,
    ).toBe(false);
  });

  it('🔴 用途说明在输入框之前，且全页只出现一次', () => {
    expect(
      wxml.indexOf('field__purpose'),
      '用途说明排在输入框后面：M-20 要求前置说，不能在提交报错里才说"会用在哪"。',
    ).toBeLessThan(wxml.indexOf('<input'));
    expect(
      wxml.match(/field__purpose/g),
      '页面上有多处 field__purpose：同一句告知重复两遍会让用户以为是两个不同的用途。',
    ).toHaveLength(1);
  });
});
