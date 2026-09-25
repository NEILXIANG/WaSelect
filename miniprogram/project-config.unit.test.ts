/**
 * 职责：小程序工程配置的 L0 单测（MP1）。
 *
 * @why 缺 `project.config.json` / `sitemap.json` 时，微信开发者工具**打不开这个项目**
 *      （"不是有效的小程序项目"），于是 F14 之后所有真机验证都无从开始——
 *      而这类缺失在 CI 里完全看不见：所有 .js / .wxml 的单测照常全绿。
 *      所以把"工程配置本身"也纳入测试，而不是靠"哪天想起来用工具打开一次"。
 *
 * @limitation 一：这里只验**仓库能控制**的部分（文件存在、JSON 合法、关键开关打开）。
 *              基础库版本、开发者工具版本这类由环境决定的东西不在这里断言——
 *              否则一次工具升级就会让全仓库变红，那是假红灯。
 * @limitation 二：读取用的是 `JSON.parse`，所以这两个配置文件**不允许写注释**。
 *              微信开发者工具其实宽容注释，但一旦有人写了，CI 立刻红而工具里照样能跑——
 *              宁可在两边都强制纯 JSON，也不要出现"CI 红/工具绿"的分裂。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_BASE } from './config.js';
import { BRAND_NAME } from '../scripts/checkout-build-lib.js';

// ⚠️ 不要拼 `'..'`：本文件就在 miniprogram/ 里，工程配置也在这里；
//    拼了 '..' 会退到仓库根，于是 existsSync 全 false、报"缺少 project.config.json"——
//    而文件其实就在旁边（我第一版就是这么写错的）。
const root = dirname(fileURLToPath(import.meta.url));

function readJson(rel: string): Record<string, unknown> {
  const file = join(root, rel);
  expect(existsSync(file), `缺少 ${rel}`).toBe(true);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('project.config.json（MP1）', () => {
  const cfg = readJson('project.config.json');

  it('compileType 是 miniprogram（否则开发者工具不认这个项目）', () => {
    expect(cfg.compileType).toBe('miniprogram');
  });

  /**
   * ES Module 语法（`export function`）依赖增强编译。
   * @why utils/random-id.js 用的是 `export`，普通 ES6 转译**不支持** import/export——
   *      表现为工具里报 "Unexpected token 'export'"，而 vitest 里一切正常（Node 原生支持 ESM）。
   *      这是典型的"测试全绿、真机打不开"。
   */
  it('开启 es6 + enhance（否则 utils 里的 export 语法编译不过）', () => {
    const setting = cfg.setting as Record<string, unknown>;
    expect(setting.es6).toBe(true);
    expect(setting.enhance).toBe(true);
  });

  /**
   * 存在非测试 .ts 源文件 ⇒ `useCompilerPlugins` 必须含 typescript（二次审查 P1）。
   *
   * @why utils/ 下的 .ts（storage/wx-api）被 app.js 等以 `.js` 后缀引用；而工具的 TS 支持
   *      是**编译插件**——"enhance" 是 babel 管线，不编译 .ts 成可打包模块。
   *      CI 全链路（vitest 的 .js→.ts 映射、simulate 只载组件）都不过微信打包器，
   *      于是"测试全绿、工具打不开"——正是本文件反复声明要防的形态。
   *      官方依据：developers.weixin.qq.com/miniprogram/dev/devtools/compilets
   *      （旧项目须在 project.config.json 的 setting 配 useCompilerPlugins: ["typescript"]）。
   * @limitation 插件开启后 `.js` specifier 指向仅存 `.ts` 文件的解析，官方文档未逐字写明
   *             （"同名 ts 优先"覆盖的是同名共存场景）——真机点亮验证挂在 F16 L4；
   *             若失败，回退方案是把两件 utils 改回 .js + JSDoc。
   */
  it('存在非测试 .ts 源文件 ⇒ 必须开启 typescript 编译插件（否则真机白屏）', () => {
    const tsSources = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(
        (e) =>
          e.isFile() &&
          e.name.endsWith('.ts') &&
          !e.name.endsWith('.unit.test.ts') &&
          !e.name.endsWith('.d.ts'),
      )
      .map((e) => join(e.parentPath, e.name));
    const setting = cfg.setting as Record<string, unknown>;
    const plugins = (setting.useCompilerPlugins as string[] | undefined) ?? [];
    if (tsSources.length > 0) {
      expect(
        plugins,
        `存在 ${tsSources.length} 件非测试 .ts 源文件（如 ${tsSources[0]}），useCompilerPlugins 必须含 typescript`,
      ).toContain('typescript');
    }
  });

  it('占位 appid 用 touristappid（未取得境外主体 AppID 前不能写死别的值）', () => {
    expect(cfg.appid).toBe('touristappid');
  });

  it('导航标题含品牌名（BRAND_NAME 同源；品牌定稿后只改一处，三端不该各写各的）', () => {
    /**
     * @why admin-web index.html 与 checkout 的品牌名都有同源断言（design-token.unit.test /
     *      renderPage 占位替换），app.json 是第三个写品牌名的地方却没有断言（二次审查 P3）。
     *      骨架期允许"（骨架）"后缀——它不是品牌的一部分，去掉后缀后必须逐字等于品牌名。
     */
    const app = readJson('app.json');
    const window = app.window as { navigationBarTitleText?: string };
    const title = window.navigationBarTitleText ?? '';
    expect(title.replace('（骨架）', '')).toBe(BRAND_NAME);
  });

  it('测试文件不进上传包（*.unit.test.ts 不该被打包上传）', () => {
    const pack = cfg.packOptions as { ignore?: { value: string }[] };
    expect(pack.ignore?.map((i) => i.value)).toContain('**/*.unit.test.ts');
  });

  /**
   * `urlCheck` 必须与 `API_BASE` 的"是否可上线"一致——这是**两个文件之间的不变式**。
   *
   * @why 骨架期 `API_BASE` 是 `http://localhost:3000`：它永远进不了微信后台的合法域名白名单
   *      （白名单要求 https + 备案域名），所以本地必须 `urlCheck: false` 才能发请求。
   *      反过来，将来换成正式 https 域名后必须**改回 true**——
   *      否则"忘了去后台配白名单"这件事在本地完全看不见，一直要到真机预览才炸，
   *      而真机排查成本远高于本地。这条断言把那个"将来的必须"钉在现在。
   * @limitation 只读 `API_BASE` 这一个字段做判断：若将来配置拆成多环境（dev/stg/prod），
   *              这里要改成判断"当前构建所选环境"的地址，而不是文件里的字面量。
   */
  it('urlCheck 与 API_BASE 一致（localhost/http → 必须关校验；https 正式域名 → 必须开）', () => {
    const setting = cfg.setting as Record<string, unknown>;
    const isLocal = /^http:\/\//.test(API_BASE) || /(^|\/)localhost|127\.0\.0\.1/.test(API_BASE);
    expect(setting.urlCheck, `API_BASE=${API_BASE} 时 urlCheck 应为 ${!isLocal}`).toBe(!isLocal);
  });
});

describe('sitemap.json（MP1）', () => {
  const sitemap = readJson('sitemap.json');
  const app = readJson('app.json');

  it('是合法 JSON 且有 rules 数组', () => {
    expect(Array.isArray(sitemap.rules)).toBe(true);
  });

  it('规则不能互相矛盾：最后一条通配规则会覆盖前面（微信按**顺序**匹配）', () => {
    const rules = sitemap.rules as { action: string; page: string }[];
    // ⚠️ 微信对 sitemap 是**从上到下、命中即停**：若把 `"*": allow` 写在最前，
    //    后面所有 disallow 都不会生效——表现为"本该不索引的页面被收录了"，且不易察觉。
    const wildcardIndex = rules.findIndex((r) => r.page === '*');
    expect(wildcardIndex).toBe(rules.length - 1);
  });

  /**
   * 黑名单制的安全网：**私有/开发页的页面前缀必须显式 disallow**。
   *
   * @why sitemap 用黑名单制（默认收录）是商业决策：商城需要微信搜一搜把商品页带进来。
   *      白名单制的失效形态是"新页面上线后静默不被收录"——业务损失且没有任何报错；
   *      黑名单制的失效形态反过来：私密页（订单/支付/地址）被默认收录——同样不报错。
   *      两种都得用机器兜，这里兜的是黑名单这一侧：凡是私有前缀的页面，
   *      没有对应 disallow 规则就立刻红，而不是等用户在搜索引擎里刷到自己的订单页。
   * @limitation 前缀名单是手维护的：新增一类私密页（如售后/客服）要同步加进
   *             PRIVATE_PREFIXES——加的时候这条测试会先红（没有 disallow），提醒动作完整。
   */
  it('私有前缀页面必须显式 disallow（黑名单制下，漏一条就是私密页被收录）', () => {
    const PRIVATE_PREFIXES = [
      /^pages\/comp\//, // 组件样板页（开发用）
      /^pages\/order[-/]/, // 订单
      /^pages\/pay[-/]/, // 支付
      /^pages\/cart[-/]/, // 购物车
      /^pages\/user[-/]/, // 我的/账户
      /^pages\/address[-/]/, // 地址簿（含收件人 PII）
      /^pages\/admin[-/]/, // 管理类页面（若有）
    ];
    const rules = sitemap.rules as { action: string; page: string }[];
    const pages = app.pages as string[];
    for (const page of pages) {
      if (!PRIVATE_PREFIXES.some((re) => re.test(page))) continue;
      const hit = rules.some((r) => r.action === 'disallow' && (r.page === page || r.page === '*'));
      // ⚠️ `disallow *` 不算数：那是白名单制，与黑名单制互斥（见上一条断言的顺序约束）
      const explicit = rules.some((r) => r.action === 'disallow' && r.page === page);
      expect(
        explicit && hit,
        `私有页面 ${page} 没有显式 disallow 规则——黑名单制下它会被微信收录`,
      ).toBe(true);
    }
  });

  it('disallow 规则指向的页面必须真实存在（防"页面改名后规则失效、新页面裸奔"）', () => {
    const rules = sitemap.rules as { action: string; page: string }[];
    const pages = app.pages as string[];
    for (const r of rules) {
      if (r.action !== 'disallow' || r.page === '*') continue;
      expect(pages, `disallow 了不存在的页面 ${r.page}（改名后这条规则已失效）`).toContain(r.page);
    }
  });
});

describe('app.json 与文件不漂移（MP1）', () => {
  const app = readJson('app.json');

  it('pages 里每一项都有 .js / .wxml / .json 三个文件', () => {
    const pages = app.pages as string[];
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      for (const ext of ['.js', '.wxml', '.json']) {
        expect(existsSync(join(root, `${page}${ext}`)), `缺少 ${page}${ext}`).toBe(true);
      }
    }
  });

  it('app.js / app.wxss / app.json 都在（缺 app.js 项目无法初始化）', () => {
    for (const f of ['app.js', 'app.json', 'app.wxss']) {
      expect(existsSync(join(root, f)), `缺少 ${f}`).toBe(true);
    }
  });

  it('pages 无重复项（微信会直接报 "pages 不能重复"，且报错信息不指向具体行）', () => {
    const pages = app.pages as string[];
    expect(new Set(pages).size).toBe(pages.length);
  });

  /**
   * 页面路径必须是**相对路径**：以 `/` 或 `./` 开头时开发者工具报的路径错和文件缺失错一模一样，
   * 看不出来是多了个斜杠。
   * @limitation 只查前导字符，不校验路径是否真实存在于磁盘（那是"pages 每项三文件齐备"那条断言的职责）。
   */
  it('pages 路径不以 / 或 ./ 开头（多了个斜杠的报错和"文件不存在"一样，极难分辨）', () => {
    const pages = app.pages as string[];
    for (const page of pages) {
      expect(/^[./]/.test(page), `页面路径 ${page} 不应以 / 或 ./ 开头`).toBe(false);
    }
  });

  it('entryPagePath 若配置则必须在 pages 里（配置不存在的首页 = 启动白屏）', () => {
    const entry = app.entryPagePath as string | undefined;
    if (entry === undefined) return; // 未配置时取 pages[0]，合法
    expect(app.pages as string[]).toContain(entry);
  });
});
