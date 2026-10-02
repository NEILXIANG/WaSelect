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
import { API_BASES } from './config.js';
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

/**
 * 页面 js 里的**路径常量表**：`const PAY_PAGE = '/pages/pay/index'` → `{PAY_PAGE: '/pages/pay/index'}`。
 *
 * @why 跳转路径在本仓库一律走常量（"路径只在这一处出现"），所以"跳到哪"要经常量解析才读得到。
 * @limitation 只认 `const 大写常量 = '字面量'` 这一种形态；`let` / 拼接都不认（当前没有）。
 */
function pathConsts(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(
    /const\s+([A-Z][A-Z0-9_]*)\s*=\s*'(\/pages\/[a-z0-9-]+\/index)(?:\?[^']*)?'/g,
  )) {
    if (m[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

/**
 * 某份页面 js 里**真的被跳转 API 跳到**的页面路径（已去掉前导斜杠）。
 *
 * @why 不扫"文件里出现过这个字面量"：常量声明本身就是字面量，那样会把
 *      "路径常量声明了、但没有任何跳转用它"也算成有入口（实测注入时 exit=0，
 *      见下面那条断言的 @how）。只有从调用点取证才不是自证。
 *
 * @why S5 之后加入 **`switchTab`**（此前只认 `navigateTo` / `redirectTo`）：
 *      tab 页**只能**用 `switchTab` 跳，而这条门禁的初衷是"可达性"——
 *      只认压栈式跳转会把"四个 tab 页"整片判成孤岛（实测：S5 切完立刻红两条），
 *      于是这条门禁从"守可达性"变成"逼人不许用 tabBar"，与它的目的正好相反。
 *      ⚠️ 这是补覆盖缺口，不是放宽门禁：`switchTab` 与 `navigateTo` 一样要求
 *      "常量真的被某个调用点用过"，自证那条断言（下面那条）对两者同样成立。
 *
 * @limitation 调用点的匹配是形态级正则（入参对象里 `url:` 的值），不是 AST：
 *      写成一个变量再传（`const u = PAY_PAGE; navigateTo({url: u})`）扫不到。
 */
function jumpTargets(src: string): string[] {
  const consts = pathConsts(src);
  /** 查常量表；未声明过的名字一律当"没有"（拼错的名字不是路径）。 */
  const resolve = (name: string | undefined): string | undefined =>
    name === undefined ? undefined : consts[name];
  const out: string[] = [];
  const calls = src.matchAll(/\b(?:navigateTo|redirectTo|switchTab)\(\{[\s\S]*?\}\s*\)/g);
  for (const call of calls) {
    const arg = call[0].slice(call[0].indexOf('url:'));
    // ① 直接字面量：`url: '/pages/x/index'` 或带 query
    const lit = arg.match(/^url:\s*'(\/pages\/[a-z0-9-]+\/index)/);
    if (lit?.[1] !== undefined) {
      out.push(lit[1].slice(1));
      continue;
    }
    // ② 模板串里的常量：`url: `${PAY_PAGE}?orderId=${id}``
    const fromTpl = resolve(arg.match(/^url:\s*`\$\{([A-Z][A-Z0-9_]*)\}/)?.[1]);
    if (fromTpl !== undefined) {
      out.push(fromTpl.slice(1));
      continue;
    }
    // ③ 裸常量：`url: CART_PAGE`
    const fromBare = resolve(arg.match(/^url:\s*([A-Z][A-Z0-9_]*)\s*[,\s}]/)?.[1]);
    if (fromBare !== undefined) out.push(fromBare.slice(1));
  }
  return out;
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
     *      AJ-180：提审版不再允许"（骨架）"后缀——审核员看到的标题栏写着"骨架"，就是在自报未完成。
     */
    const app = readJson('app.json');
    const window = app.window as { navigationBarTitleText?: string };
    expect(window.navigationBarTitleText ?? '').toBe(BRAND_NAME);
  });

  it('测试文件不进上传包（*.unit.test.ts 不该被打包上传）——通配写法必须用 glob 类型', () => {
    /**
     * @measured(developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.html, 2026-09-29)：
     *   packOptions.ignore 的 type 取值 folder / file / suffix / prefix / regexp / glob；
     *   示例 `{"type": "file", "value": "test/test.js"}` 是**单个文件路径**，通配写 `{"type": "glob", ...}`。
     * @why 曾经写成 `{"type": "file", "value": "**\/*.unit.test.ts"}`：file 类型按路径精确匹配，
     *      这条规则大概率什么都没排除（AJ-180）——而且没有任何报错。
     */
    const pack = cfg.packOptions as { ignore?: { type: string; value: string }[] };
    expect(pack.ignore).toContainEqual({ type: 'glob', value: '**/*.unit.test.ts' });
    for (const rule of pack.ignore ?? []) {
      if (rule.value.includes('*'))
        expect(rule.type, `${rule.value} 含通配却不是 glob`).toBe('glob');
    }
  });

  it('开发页不进发布包：骨架页 pages/index 与样板页 pages/comp 不登记、按目录排除（提审前 O-14，AJ-180）', () => {
    const pages = readJson('app.json').pages as string[];
    expect(pages).not.toContain('pages/index/index');
    expect(pages).not.toContain('pages/comp/index');
    const pack = cfg.packOptions as { ignore?: { type: string; value: string }[] };
    expect(pack.ignore).toContainEqual({ type: 'folder', value: 'pages/index' });
    expect(pack.ignore).toContainEqual({ type: 'folder', value: 'pages/comp' });
  });

  /**
   * `urlCheck` 必须与"有没有任一环境指向本地"一致——这是**两个文件之间的不变式**。
   *
   * @why 骨架期 `API_BASES.develop` 是 `http://localhost:3000`：它永远进不了微信后台的合法域名
   *      白名单（白名单要求 https + 备案域名），所以本地必须 `urlCheck: false` 才能发请求。
   *      反过来，**所有环境都换成 https 正式域名之后必须改回 true**——
   *      否则"忘了去后台配白名单"这件事在本地完全看不见，一直要到真机预览才炸，
   *      而真机排查成本远高于本地。这条断言把那个"将来的必须"钉在现在。
   *
   * @why 2026-10-01（B4）判据从单个 `API_BASE` 改成"**任一**环境地址是本地"：
   *      配置已拆成 develop / trial / release 三档（@see miniprogram/config.js）。
   *      只要还有一档指向本地，`urlCheck: true` 会让**那一档彻底跑不起来**；
   *      三档全 https 时还没有改回 true，则是上面那个"看不见"的风险。
   *      ⚠️ 于是当前（develop=localhost）这条恒等于 `urlCheck: false`——
   *      它看起来像常量断言，但把 develop 换成 https 联调域名的那天它就会翻过来。
   * @limitation `urlCheck` 只影响开发者工具与真机调试（开发版）；体验版与正式版
   *      **始终**强制校验合法域名。所以当 develop 仍是 localhost、
   *      而 trial/release 已配 https 时，"trial/release 的域名没登记"在本地是看不见的——
   *      那道缺口由 B5 的清单对账补（`test/config/wechat-domains.unit.test.ts`），
   *      本条不重复承担。
   */
  it('urlCheck 与"是否还有环境指向本地"一致（有 → 必须关校验；三档全 https → 必须开）', () => {
    const setting = cfg.setting as Record<string, unknown>;
    const isLocal = (base: string): boolean =>
      /^http:\/\//.test(base) || /(^|\/)localhost|127\.0\.0\.1/.test(base);
    const anyLocal = Object.values(API_BASES).some(isLocal);
    expect(
      setting.urlCheck,
      `API_BASES=${JSON.stringify(API_BASES)} 时 urlCheck 应为 ${!anyLocal}`,
    ).toBe(!anyLocal);
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
  /** `tabBar` 的形状（S5 之后才有）；没有 tabBar 时是 `{}`，下面的断言按此退化。 */
  const tabBar = (app.tabBar ?? {}) as {
    custom?: boolean;
    list?: { pagePath?: string }[];
  };

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

  /**
   * 反向断言：**建了页面就得登记**（U-H1 缺陷注入⑦ 实测出来的空白）。
   *
   * @why 上面"pages 里每项都有三个文件"是**正向**的，它只能发现"登记了但文件不全"。
   *      反向的失效——`pages/legal/index.wxml/.js/.json` 三件套齐备，却忘了写进
   *      `app.json` 的 `pages`——**不会让任何一条测试变红**（实测注入后 exit=0）：
   *      页面在磁盘上好好的，只是小程序永远打不开它，而跳转它的那一行会静默失败。
   *      这是"新东西悄悄脱离防线"的典型形态：代码全对，用户那儿是死的。
   *      于是"新建页面的动作"必须有机器兜底，不能靠"记得在 app.json 里也加一行"。
   * @limitation 判定标准是"目录下有 `index.wxml`"：小程序页面允许自定义文件名
   *              （`pages/x/main.wxml`），那种页面这条扫不到（当前没有，且与
   *              `pages` 里"每项都有 .js/.wxml/.json"那条共用同一个约定——都叫 index）。
   */
  it('pages 目录下的每个页面目录都登记在 app.json 里（建了不登记 = 永远打不开）', () => {
    const pages = app.pages as string[];
    const dirs = readdirSync(join(root, 'pages'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs.length, 'pages 目录是空的——路径写错了？').toBeGreaterThan(0);
    // 开发页（骨架页 / 样板页）刻意不登记、按目录排除出上传包（AJ-180）：豁免名单**取自** packOptions.ignore
    // 的 folder 规则（单一来源）——只在这里写死名字，两处会各自漂移
    const packCfg = readJson('project.config.json').packOptions as {
      ignore?: { type: string; value: string }[];
    };
    const devDirs = new Set(
      (packCfg.ignore ?? []).filter((r) => r.type === 'folder').map((r) => r.value),
    );
    const orphans = dirs
      .filter((d) => existsSync(join(root, 'pages', d, 'index.wxml')))
      .filter((d) => !devDirs.has(`pages/${d}`))
      .map((d) => `pages/${d}/index`)
      .filter((p) => !pages.includes(p));
    expect(
      orphans,
      `这些页面三件套齐备却没有登记进 app.json 的 pages：${orphans.join('、')}——` +
        `小程序永远打不开它们，跳过去的那一行会静默失败`,
    ).toEqual([]);
  });

  /**
   * 可达性断言：**每个业务页都至少被一个页面跳到**。
   *
   * @why 与上面两条同一族，但守的是第三半：一个页面可以「登记了 + 三件套齐备」，
   *      却**没有任何路径能走到它**——U-H2 之前的订单 / 地址 / 法务三页正是这个状态：
   *      它们能跑、测试也绿，但用户从首页出发永远到不了（付完款回到首页，订单就找不到了）。
   *      这种"孤岛页"不报错、不崩溃，只在新页面加进来之后**悄悄脱离可达图**，
   *      而"有没有入口"从来不在任何一个文件的本地视野里——只能跨文件扫描。
   * @how **只认"真的被跳转"**，不认"存在过一个字面量"：
   *      ① 先在每个页面 js 里收集路径常量（`const PAY_PAGE = '/pages/pay/index'`）；
   *      ② 只从 `navigateTo` / `redirectTo` 的入参里取目标（字面量、`${CONST}`、裸 `CONST`）。
   *      @why 必须做到 ②：**第一版只扫"文件里出现过这个字面量"，注入
   *      "删掉 `onGoMine`、只留 `const USER_PAGE = '/pages/user/index'`"时 exit=0**——
   *      因为常量声明本身就是那个字面量，扫描器读到的正是"没人用的声明"。
   *      那是 §2 第 21 条的自证：从被测对象自己留下的痕迹里取证，当然永远成立。
   *      @limitation 拼出来的路径（`'/pages/' + name + '/index'`）扫不到——当前没有，
   *      出现时这条要升级为真正的表达式解析，而不是假装它不存在。
   * @limitation 启动页刻意没有入口，走**白名单**豁免而不是"看起来没人链就放过"
   *      （两个开发页已移出 app.json，AJ-180）。
   */
  it('每个业务页都至少被一个页面跳到（没有入口 = 用户永远走不到，但不报错）', () => {
    /**
     * 不需要入口的页面。@see @limitation
     * - `pages[0]`：**启动页**，它由 App 启动进入而不是被跳转进来（写死首页路径会在这个文件里
     *   多一份真源，首页改名时两处都要改——所以按 `pages[0]` 取）。
     * （两个开发页 `pages/index` / `pages/comp` 已不登记进 app.json，AJ-180——不在 pages 里就不需要豁免。）
     */
    const NO_ENTRY_NEEDED = [(app.pages as string[])[0]];
    /** 递归收页面 js（含 `.vm.js`：跳转路径常量也可能落在页面目录的任何一处）。 */
    const files: string[] = [];
    for (const entry of readdirSync(join(root, 'pages'), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith('.js'))
        files.push(join(entry.parentPath, entry.name));
    }
    expect(files.length, 'pages 下一个 js 都没扫到——扫描根改坏了？').toBeGreaterThan(0);

    const targets = new Set<string>();
    for (const abs of files) {
      for (const t of jumpTargets(readFileSync(abs, 'utf8'))) targets.add(t);
    }
    /**
     * tabBar 上的页面**天然有入口**：底部栏在 tab 页上一直可见。
     * @why S5 之后必须把这一条显式写进来：tab 页的入口是"底部那四个格子"，
     *      它不在任何页面的 js 里（宿主自己渲染），所以只扫 js 的跳转调用点
     *      永远扫不到——不补这一条就会把 tabBar 本身判成"不可达"。
     *      ⚠️ 这不是给 tab 页开后门：tabBar 的存在由宿主保证（`tabBar.custom` +
     *      根下 `custom-tab-bar/` 目录），另有一条断言钉那两件事。
     */
    for (const p of (tabBar.list ?? []).map((it) => it.pagePath ?? '')) {
      if (p !== '') targets.add(p);
    }
    expect(targets.size, '一个跳转目标都没扫到——正则或扫描根改坏了？').toBeGreaterThan(0);
    const islands = (app.pages as string[]).filter(
      (p) => !NO_ENTRY_NEEDED.includes(p) && !targets.has(p),
    );
    expect(
      islands,
      `这些页面没有任何入口：${islands.join('、')}——` +
        `它们登记了、也能跑，但用户永远走不到（可达图上的孤岛）`,
    ).toEqual([]);
  });

  it('匹配器自检：路径常量"声明了却没人跳"**不算**入口（否则上一条是自证）', () => {
    // @why §2 第 30 条：扫描型门禁最危险的失效是**假阴性**（永远绿）。
    //      这一条专门钉住"第一版那个洞"：只扫字面量时，常量声明本身就是字面量，
    //      于是"删掉跳转、只留声明"照样绿——那正是 U-H2 要防的事。
    expect(jumpTargets("const USER_PAGE = '/pages/user/index';\n")).toEqual([]);
    expect(jumpTargets("const P = '/pages/pay/index';\nwxApi.navigateTo({ url: P });")).toEqual([
      'pages/pay/index',
    ]);
    expect(
      jumpTargets("const P = '/pages/pay/index';\nwxApi.navigateTo({ url: `${P}?orderId=x` });"),
    ).toEqual(['pages/pay/index']);
    expect(jumpTargets("wxApi.navigateTo({ url: '/pages/legal/index' });")).toEqual([
      'pages/legal/index',
    ]);
    expect(jumpTargets("wxApi.navigateTo({ url: '/pages/address/index?pick=1' });")).toEqual([
      'pages/address/index',
    ]);
  });
});
