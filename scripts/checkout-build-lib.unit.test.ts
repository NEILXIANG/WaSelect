/**
 * 职责：checkout-static 地基（F15 单元①）的 L0 单测——_redirects 规则、构建产物、token 闭环。
 *
 * @why `_redirects` 是 D-49 银行卡链路的**第一跳**：短链 `checkout.<domain>/o/:id` 若不能
 *      正确 302 到 API 的 `/pay/link`，用户复制链接后哪儿也去不了，而且静态文件部署
 *      没有任何运行时报错——只表现为"链接打不开"。所以规则必须在仓库内可测，
 *      而不是等 Cloudflare 部署后用手点。
 *
 * @why CSS 变量闭环是扫描类断言，按 §2 第 34 条配自检：`var(--ws-typo)` 拼错不报错、
 *      只是静默失效（与 AJ-66 小程序 design-token 门禁同款教训），
 *      扫描器写坏后业务断言照样全绿，只有自检会红。
 *
 * @see scripts/checkout-build-lib.ts（被测）；server/src/adapters/payment/channels.ts
 *      （STRIPE_RETURN_PATHS 同源）；docs/地基搭建清单.md F15
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WS_COLORS } from '@waselect/shared';
import { STRIPE_RETURN_PATHS } from '../server/src/adapters/payment/channels.js';
import {
  assertDeployApiBase,
  BRAND_NAME,
  CHECKOUT_PAGES,
  collectCssVars,
  matchRedirect,
  parseRedirects,
  renderPage,
  renderRedirects,
  renderTokensCss,
} from './checkout-build-lib.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.example.com';

/** 生成并解析回规则（测的闭环：生成 → 解析 → 匹配，三段都必须对）。 */
function generatedRules() {
  return parseRedirects(renderRedirects(API));
}

describe('renderRedirects：生成短链转发规则', () => {
  it('生成恰好一条规则：/o/* → {API}/api/v1/pay/link/:splat 302', () => {
    const rules = generatedRules();
    expect(rules).toEqual([
      { source: '/o/*', destination: `${API}/api/v1/pay/link/:splat`, status: 302 },
    ]);
  });

  it('apiBase 尾斜杠被归一（否则会拼出双斜杠）', () => {
    const rules = parseRedirects(renderRedirects(`${API}/`));
    expect(rules[0]?.destination).toBe(`${API}/api/v1/pay/link/:splat`);
  });

  it('apiBase 带路径或非 http(s) → 拒绝（写错环境变量要响亮）', () => {
    expect(() => renderRedirects(`${API}/v2`)).toThrow(/路径/);
    expect(() => renderRedirects('ftp://api.example.com')).toThrow(/http/);
    expect(() => renderRedirects('not-a-url')).toThrow(/http/);
  });
});

describe('assertDeployApiBase：CF Pages 构建的部署闸门（体检 N16）', () => {
  /**
   * @why CF Pages 无 IaC：环境变量漏配时构建照样成功，产物 _redirects 静默指向
   *      localhost——"付款短链全灭"且发现靠用户反馈。部署构建必须要么真值要么失败。
   */
  it('localhost / 回环地址 → 拒绝（漏配 PUBLIC_API_BASE 的默认形态）', () => {
    expect(() => assertDeployApiBase('http://localhost:3000')).toThrow(/https 公网地址/);
    expect(() => assertDeployApiBase('http://127.0.0.1:3000')).toThrow(/https 公网地址/);
    expect(() => assertDeployApiBase('http://0.0.0.0:3000')).toThrow(/https 公网地址/);
  });

  it('http 公网地址 → 同样拒绝（生产必须 https）', () => {
    expect(() => assertDeployApiBase('http://api.example.com')).toThrow(/https 公网地址/);
  });

  it('https 公网地址 → 放行', () => {
    expect(() => assertDeployApiBase('https://api.example.com')).not.toThrow();
  });

  it('自检：闸门对本机判定真的覆盖三种写法（扫歪了会静默放行）', () => {
    // 与 §2 第 34 条同款：扫描/判定类逻辑必须证明"坏输入真的会红"
    for (const bad of ['http://localhost:3000', 'http://127.0.0.1', 'http://[::1]:3000']) {
      expect(() => assertDeployApiBase(bad), `${bad} 应被拒绝`).toThrow();
    }
  });
});

describe('parseRedirects：解析（Cloudflare 语义子集）', () => {
  it('注释与空行被跳过；状态缺省 302、显式 301 可识别', () => {
    const rules = parseRedirects(['# 注释', '', '/a /b', '/c /d 301'].join('\n'));
    expect(rules).toEqual([
      { source: '/a', destination: '/b', status: 302 },
      { source: '/c', destination: '/d', status: 301 },
    ]);
  });
});

describe('matchRedirect：D-49 第一跳', () => {
  const rules = generatedRules();

  it('短链 /o/:id → API /pay/link/:id（302，splat 替换）', () => {
    expect(matchRedirect(rules, '/o/abc123')).toEqual({
      destination: `${API}/api/v1/pay/link/abc123`,
      status: 302,
    });
  });

  it('path 形式带 token 也能整体转发（/o/:id/:t → /pay/link/:id/:t）', () => {
    // @why 兜底设计：CF 对「查询串是否随 302 保留」没有文档化承诺（已登记 L4 实测项）。
    //      若 L4 证明 ?t= 会丢，I1 可把短链改成 path 形式——这条规则两种形态都兼容。
    expect(matchRedirect(rules, '/o/abc123/tok456')).toEqual({
      destination: `${API}/api/v1/pay/link/abc123/tok456`,
      status: 302,
    });
  });

  it('静态页路径不匹配转发规则（/pay/* 由 Pages 托管，不能被吃掉）', () => {
    for (const page of CHECKOUT_PAGES) {
      expect(matchRedirect(rules, page), `${page} 不该被转发`).toBeNull();
    }
  });

  it('无 splat 的精确匹配 + 首条规则优先', () => {
    const custom = parseRedirects(['/x /first 302', '/x /second 301', '/y /third'].join('\n'));
    expect(matchRedirect(custom, '/x')?.destination).toBe('/first');
    expect(matchRedirect(custom, '/y')?.destination).toBe('/third');
    expect(matchRedirect(custom, '/z')).toBeNull();
  });
});

describe('页面清单：三张页都存在且与 channels.ts 同源', () => {
  it('CHECKOUT_PAGES 每个都有 index.html', () => {
    for (const page of CHECKOUT_PAGES) {
      const file = join(root, 'checkout-static', page, 'index.html');
      expect(() => readFileSync(file, 'utf8'), `${page} 缺 index.html`).not.toThrow();
    }
  });

  it('STRIPE 回跳路径（channels.ts 同源）都在页面清单里', () => {
    // @why channels.ts 把 successUrl/cancelUrl 拼成 `${base}/pay/done|cancelled`——
    //      静态站若没这两张页，用户付完款落到 404，且回调照样落账（钱收了、页面挂了）。
    expect(CHECKOUT_PAGES).toContain(STRIPE_RETURN_PATHS.success);
    expect(CHECKOUT_PAGES).toContain(STRIPE_RETURN_PATHS.cancel);
  });
});

describe('design token：颜色单一来源（packages/shared）', () => {
  it('生成的 tokens.css 含全部颜色变量', () => {
    const css = renderTokensCss(WS_COLORS);
    for (const [k, v] of Object.entries(WS_COLORS)) {
      expect(css).toContain(`--ws-color-${k}: ${v};`);
    }
  });

  it('小程序 app.wxss 的五色与 WS_COLORS 同值（两处共存，靠本条钉住漂移）', () => {
    // @limitation app.wxss 是手写维护的另一份（rpx 尺寸无法共享），
    //              颜色若改必须两边同改——本条就是那个"必须同改"的机器提醒。
    const wxss = readFileSync(join(root, 'miniprogram/app.wxss'), 'utf8');
    for (const k of ['bg', 'card', 'fg', 'muted', 'error'] as const) {
      expect(wxss, `app.wxss 的 --ws-color-${k} 与 WS_COLORS 漂移`).toContain(
        `--ws-color-${k}: ${WS_COLORS[k]};`,
      );
    }
  });

  it('生成者标识可定制且默认仍是 build-checkout（产物注释不许撒谎，ADR-29）', () => {
    expect(renderTokensCss(WS_COLORS)).toContain('由 build-checkout 生成');
    expect(renderTokensCss(WS_COLORS, 'gen-admin-tokens')).toContain('由 gen-admin-tokens 生成');
    expect(renderTokensCss(WS_COLORS, 'gen-admin-tokens')).not.toContain('build-checkout');
  });
});

describe('CSS 变量闭环：page.css 引用的每个变量都有定义（扫描类，配自检）', () => {
  it('page.css 里 var(--ws-*) 的引用 ⊆ tokens.css 与 page.css 自身的定义', () => {
    const pageCss = readFileSync(join(root, 'checkout-static/assets/page.css'), 'utf8');
    const defined = new Set([
      ...collectCssVars(renderTokensCss(WS_COLORS), 'definitions'),
      ...collectCssVars(pageCss, 'definitions'),
    ]);
    const used = collectCssVars(pageCss, 'references');
    const missing = used.filter((v) => !defined.has(v));
    expect(missing, '引用了未定义的 CSS 变量（拼错不报错、静默失效）').toEqual([]);
  });

  it('自检：引用/定义两类提取各自全缺全报（§2 第 34 条）', () => {
    const css = ':root{--ws-a:1px}.x{color:var(--ws-b);width:var(--ws-a)}';
    expect(collectCssVars(css, 'references').sort()).toEqual(['--ws-a', '--ws-b']);
    expect(collectCssVars(css, 'definitions').sort()).toEqual(['--ws-a']);
    expect(collectCssVars('', 'references')).toEqual([]);
  });

  it('自检：注释里的变量不被扫出来（解释规则的文字不是引用）', () => {
    // @why 这条是开发时被抓出来的真缺陷：page.css 注释写「一律走 var(--ws-*)」，
    //      被当成引用 '--ws-' 扫出来 → 闭环断言误报。先剥注释再匹配（AJ-74 同款）。
    const css = '/* 一律走 var(--ws-x) */.a{color:var(--ws-y)}';
    expect(collectCssVars(css, 'references')).toEqual(['--ws-y']);
  });
});

describe('renderPage：品牌名单一来源', () => {
  it('占位被替换成品牌名（品牌定稿后只改 BRAND_NAME 一处）', () => {
    expect(renderPage('<title>__BRAND_NAME__</title>')).toBe(`<title>${BRAND_NAME}</title>`);
  });

  it('无占位时原样返回', () => {
    expect(renderPage('<p>hi</p>')).toBe('<p>hi</p>');
  });
});
