/**
 * 职责：admin-web 的 design token 门禁（F15 单元③）——页面样式不得写死，且跨文件同源钉住。
 *
 * 覆盖的失效形态（全部"不报错"型）：
 *   ① app.css 写死色值/尺寸 → 改版逐页改，漏掉的页面静默保留旧样式（约束五：UI 不写死）；
 *   ② var(--ws-xxx) 拼错 → CSS 不报错，那条样式静默失效（引用⊆定义闭环）；
 *   ③ tokens.css 忘了生成（pre 钩子被删）→ fresh clone 跑 dev 时样式全无，且没人知道为什么；
 *   ④ vite 端口与 server CORS 白名单漂移 → 本地联调跨域全挂，报的是"网络错误"而不是"端口错了"；
 *   ⑤ index.html 品牌名与 BRAND_NAME 漂移 → 品牌定稿后改了一处漏一处。
 *
 * @why 硬编码扫描器与 miniprogram/design-token.unit.test.ts 是**同源复制**（正则集合一致）——
 *      它不导出（测试文件自包含），为共享而改造一个 ✅ 单元的代价大于复制；
 *      漂移风险由两边的"扫描器自检"用例各自兜底（同一批脏样本）。
 *
 * @see scripts/checkout-build-lib.ts（collectCssVars / BRAND_NAME 复用）；scripts/admin-tokens-lib.ts（管理端 tokens，AJ-411）；
 *      miniprogram/design-token.unit.test.ts（扫描器同源）；docs/地基搭建清单.md F15
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_COLORS, ADMIN_LEGACY_ALIASES, WS_COLORS } from '@waselect/shared';
import { renderAdminTokensCss } from '../../scripts/admin-tokens-lib.js';
import { BRAND_NAME, collectCssVars } from '../../scripts/checkout-build-lib.js';

/** 管理端 tokens.css 的现算值（AJ-411 起是管理端自己的 M3 主题，不再是买家端 WS_COLORS）。 */
const adminTokensCss = (): string => renderAdminTokensCss(ADMIN_COLORS, ADMIN_LEGACY_ALIASES);

const root = resolve(import.meta.dirname, '../..');
const adminWeb = join(root, 'admin-web');
/** token 生成物：它是唯一允许出现字面量的样式文件（定义处），且内容由生成器负责。 */
const GENERATED_TOKENS = join('src', 'tokens.css');

/** 递归列出 admin-web/src 下的 .css（排除生成物）。 */
function listPageCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listPageCss(full, out);
    else if (entry.name.endsWith('.css') && !full.endsWith(GENERATED_TOKENS)) out.push(full);
  }
  return out;
}

/** 剥块注释（否则注释里举的反例会把自己扫成违规，AJ-74 同款教训）。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const COLOR_FN = /\b(?:rgba?|hsla?)\s*\(/g;
const NAMED_COLOR =
  /:\s*(?:red|green|blue|black|white|gray|grey|yellow|orange|purple|pink|brown|cyan|magenta)\b/g;

/** 违规清单（与 miniprogram 版同源）：色值 / 色值函数 / 颜色关键字 / 非 0 px 尺寸。 */
function violations(css: string): string[] {
  const body = stripComments(css);
  const sizes = [...body.matchAll(/(\d*\.?\d+)(px)\b/g)]
    .filter((m) => Number(m[1]) !== 0)
    .map((m) => `尺寸 ${m[0]}`);
  return [
    ...(body.match(HEX) ?? []).map((s) => `色值 ${s}`),
    ...(body.match(COLOR_FN) ?? []).map((s) => `色值函数 ${s.trim()}`),
    ...(body.match(NAMED_COLOR) ?? []).map((s) => `颜色关键字 ${s.trim()}`),
    ...sizes,
  ];
}

const pageCssFiles = listPageCss(join(adminWeb, 'src'));

describe('扫描范围（空扫描会让下面所有断言变成假绿灯，§2 第 34 条）', () => {
  it('至少扫到一个非生成物 css，且扫描器自检（脏样本全报 / 干净样本不报 / 注释不扫）', () => {
    expect(pageCssFiles.length, 'admin-web/src 下没扫到 css——目录搬走了？').toBeGreaterThan(0);

    const dirty = '.a{color:#ffffff;margin:12px;border:1px solid rgb(1,2,3);background:red}';
    const found = violations(dirty);
    expect(found).toContain('色值 #ffffff');
    expect(found).toContain('尺寸 12px');
    expect(found).toContain('尺寸 1px');
    expect(found.some((s) => s.startsWith('色值函数'))).toBe(true);
    expect(found.some((s) => s.startsWith('颜色关键字'))).toBe(true);
    // 反例：token 引用 / 0 / calc 组合 var 都不算违规（否则门禁逼人写不可能通过的代码）
    expect(
      violations('.a{color:var(--ws-color-fg);margin:0;width:calc(var(--ws-space) * 2)}'),
    ).toEqual([]);
    expect(violations('/* 反例：#fff 与 12px */\n.a{color:var(--ws-x)}')).toEqual([]);
  });
});

describe('页面样式不得写死（约束五）', () => {
  it('每个非生成物 css 都没有硬编码色值 / 尺寸字面量', () => {
    const offenders = pageCssFiles.flatMap((f) => {
      const found = violations(readFileSync(f, 'utf8'));
      return found.length === 0 ? [] : [`${f}：${found.join('、')}`];
    });
    expect(offenders, `页面样式写死了值：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('var(--ws-*) 引用 ⊆ 生成 tokens 的定义 + 页面自身定义（拼错 = 静默失效）', () => {
    const defined = new Set(collectCssVars(adminTokensCss(), 'definitions'));
    const dangling = pageCssFiles.flatMap((f) => {
      const css = readFileSync(f, 'utf8');
      for (const v of collectCssVars(css, 'definitions')) defined.add(v);
      return collectCssVars(css, 'references')
        .filter((v) => !defined.has(v))
        .map((v) => `${f} 用了未定义的 ${v}`);
    });
    expect(dangling, `引用了未定义的变量：\n${dangling.join('\n')}`).toEqual([]);
  });
});

describe('tokens.css 生成链（生成物不入库，链条各环节都要有钉子）', () => {
  it('predev / prebuild 都挂着 gen-admin-tokens（钩子被删 = fresh clone 样式全无且无声）', () => {
    const pkg = JSON.parse(readFileSync(join(adminWeb, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['predev']).toContain('gen-admin-tokens');
    expect(pkg.scripts['prebuild']).toContain('gen-admin-tokens');
  });

  it('生成物若存在，与 renderAdminTokensCss 现算值逐字相等（改色没重新生成 = 漂移）', () => {
    const generated = join(adminWeb, GENERATED_TOKENS);
    let exists = true;
    try {
      statSync(generated);
    } catch {
      exists = false;
    }
    if (!exists) return; // 未生成时不查内容——钩子的存在性由上一条钉住，本条件不构成永绿
    expect(readFileSync(generated, 'utf8')).toBe(adminTokensCss());
  });
});

describe('管理端主题与买家端品牌色隔离（AJ-411）', () => {
  it('旧名 --ws-color-* 全部指向 M3 角色，且一个买家端色值都不落进管理端 tokens', () => {
    const css = adminTokensCss();
    for (const k of Object.keys(WS_COLORS)) {
      expect(css, `--ws-color-${k} 没映射`).toMatch(
        new RegExp(`--ws-color-${k}: var\\(--md-color-[\\w-]+\\);`),
      );
    }
    const leaked = Object.values(WS_COLORS).filter((hex) => hex !== '#ffffff' && css.includes(hex));
    expect(leaked, '管理端 tokens 里出现了买家端品牌色').toEqual([]);
  });
});

describe('跨文件同源（改一处忘另一处 = 联调期的事故）', () => {
  it('vite dev 端口出现在 .env.example 的 CORS_ORIGINS（端口漂移 = 本地跨域全挂）', () => {
    const viteConfig = readFileSync(join(adminWeb, 'vite.config.ts'), 'utf8');
    const portMatch = /port:\s*(\d+)/.exec(viteConfig);
    expect(
      portMatch,
      'vite.config.ts 里没找到显式 port（strictPort 纪律见该文件注释）',
    ).not.toBeNull();
    const port = portMatch?.[1] ?? '';
    const envExample = readFileSync(join(root, '.env.example'), 'utf8');
    const corsLine = envExample.split('\n').find((l) => l.startsWith('CORS_ORIGINS=')) ?? '';
    expect(corsLine, `CORS_ORIGINS 缺 localhost:${port}——本地 admin-web 会被跨域拦下`).toContain(
      `http://localhost:${port}`,
    );
  });

  it('index.html 的 title 与 BRAND_NAME 同源（品牌定稿后只改一处，漂移靠本条拦）', () => {
    const html = readFileSync(join(adminWeb, 'index.html'), 'utf8');
    expect(BRAND_NAME.length).toBeGreaterThan(0);
    expect(html).toContain(`<title>${BRAND_NAME} 管理后台</title>`);
  });
});
