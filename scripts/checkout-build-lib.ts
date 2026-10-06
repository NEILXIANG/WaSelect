/**
 * 职责：checkout-static 静态站的构建逻辑（F15 单元①）——
 *      `_redirects` 生成/解析/匹配、tokens.css 生成、品牌名替换、页面清单。
 *      与 CLI 薄壳（build-checkout.ts）分离，好让 D-49 的「第一跳」在仓库内可测。
 *
 * @why `_redirects` 由代码**生成**而不是手写：API 域名是环境相关值（dev/staging/prod 不同），
 *      手写进仓库要么写死一个环境、要么留占位靠人肉替换——两种都是"换环境就错"的形态。
 *
 * @why matchRedirect 实现的是 Cloudflare 语义的**最小子集**（精确匹配 / 单 splat / 首条生效 /
 *      状态缺省 302）。它是"我们以为 CF 会怎么做"的模型，不是 CF 本身——
 *      真平台行为（尤其**查询串是否随 302 保留**，文档未承诺）登记为 L4 实测项，
 *      部署后必须用带 `?t=` 的真实短链 curl 一遍。@limitation 不支持占位符（`:name`）——
 *      当前规则用不到，支持了反而要维护第二套语义。
 *
 * @limitation 品牌名替换是构建期字符串替换，不是文案系统：
 *              三张静态页只有品牌名一处外置；真要多语言/多文案时再谈渲染层。
 *
 * @see scripts/build-checkout.ts（CLI）；server/src/adapters/payment/channels.ts（回跳路径同源）；
 *      https://developers.cloudflare.com/pages/configuration/redirects/
 */
import { isPlaceholderHost } from '@waselect/shared';

/** 页面清单（构建时逐张复制 + 测试逐张核对存在性）。失效页的消费者是 I1 的 /pay/link（链接过期时 302 到这）。 */
export const CHECKOUT_PAGES = ['/pay/done', '/pay/cancelled', '/pay/expired'] as const;

/**
 * 产物目录（**相对仓库根**）。
 *
 * @why 抽成常量而不是在构建脚本里现拼：Cloudflare Pages **没有 IaC**
 *      （体检 N16 / B3），平台的"发布目录"是控制台里手填的一行，与这里各写一份的话
 *      改了一处另一处**不会报错**——产物被发布到别的目录，站点看起来是空的。
 *      所以部署清单（`deploy/cloudflare-pages.json`）里那份由本常量比对，
 *      两边不一致时 `test/config/checkout-pages.unit.test.ts` 直接红。
 */
export const CHECKOUT_DIST_DIR = 'checkout-static/dist';

/**
 * 品牌名单一来源。⚠️ 品牌名**待定**（候选 和選/WaSelect，见 jp README §5）——
 * 定稿后只改这一处，三张静态页由构建期替换（`__BRAND_NAME__` 占位）。
 */
export const BRAND_NAME = 'WaSelect';

/* ── _redirects：生成 ───────────────────────────────────────────────────── */

/**
 * 生成 `_redirects` 内容。
 * @param apiBase API 公网基址（`PUBLIC_API_BASE`），只允许 `http(s)://host[:port]`——
 *   带路径说明配错了环境变量（拼出来会是 `…/v2/api/v1/…` 这种双前缀，且只在点击短链时才暴露）。
 */
export function renderRedirects(apiBase: string): string {
  const trimmed = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
  if (!/^https?:\/\/[^/]+$/.test(trimmed)) {
    throw new Error(
      `PUBLIC_API_BASE 形状不合法（只允许 http(s)://host[:port]，不得带路径）：${apiBase}`,
    );
  }
  return [
    '# checkout-static 转发规则（由 build-checkout 生成，勿手改；改规则请改 scripts/checkout-build-lib.ts）',
    '# D-49 第一跳：短链 /o/:id → API /pay/link（由 API 校验后 302 到 Stripe 托管页）',
    `# CF 语义：查询串不参与匹配；splat 转发路径后缀；状态缺省 302`,
    `/o/* ${trimmed}/api/v1/pay/link/:splat 302`,
    '',
  ].join('\n');
}

/**
 * 判断本次构建是不是**部署构建**（而非本机/CI 联调构建）。
 *
 * @why 判据刻意是"我们自己声明的哨兵变量"，不是"猜平台注入了什么"：
 *      · `CF_PAGES` 由 Cloudflare Pages 注入（已有）；
 *      · `DEPLOY_TARGET` 由**我们在 `render.yaml` 里显式写**（B2 新增的 admin 静态站）。
 *        没有它，Render 的静态站构建与本机 `npm run build` 无法区分，
 *        于是"产物里烤着 localhost"这件事就没有任何一道闸会拦——
 *        而它的表现是"上线即全灭，且不报 CORS 错"（请求打在静态站自己身上，全是 404）。
 * @why 不用 `NODE_ENV=production` 当判据：Vite 在 `vite build` 时会自己把它设成 production，
 *      于是本机构建也会被判成部署构建，联调产物直接构建失败——闸门必须有**假阴性**，不能有假阳性。
 *
 * @limitation 只认这两个哨兵。将来换平台（Netlify / Vercel）要在这里加一条，
 *             并在该平台的构建环境里显式声明哨兵——**不要**改成"检测某个环境变量是否存在"，
 *             那种写法会在平台改名/改名变量时静默失效（闸门直接消失且不报错）。
 */
export function isDeployBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CF_PAGES !== undefined || env.DEPLOY_TARGET !== undefined;
}

/**
 * 部署构建的 API 基址闸门：`PUBLIC_API_BASE` / `VITE_API_BASE_URL` 必须是 https 公网地址。
 *
 * @why 静态站托管没有 IaC（体检 N16 / B2-B3）：环境变量漏配时构建**照样成功**，
 *      产物静默指向 localhost 默认值——checkout 是"用户点短链全部打不开"，
 *      admin 是"运营打开后台全是 404"。发现它们的方式都是"用户来说坏了"。
 *      部署构建要么拿到真值，要么响亮失败。
 * @limitation 只在本机/CI 联调构建时放行 localhost（那是刻意的：联调就要打本机 API）。
 *
 * @why 还要挡**占位域**（AJ-375）：只挡 localhost 时，`https://api.example.com` 照样通过——
 *      它是合法的 https 公网地址，于是产物里烤着一个不存在的域，静态站每个请求都是 404，
 *      而构建日志、部署日志、健康检查全绿。与服务端 `config.ts` 规则 4c 是同一条判据的两个落点
 *      （启动期 / 构建期），共用 `packages/shared` 的 `isPlaceholderHost`，不各写一份。
 */
export function assertDeployApiBase(apiBase: string, varName = 'PUBLIC_API_BASE'): void {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(apiBase);
  if (isLocal || !apiBase.startsWith('https://')) {
    throw new Error(
      `部署构建要求 ${varName} 是 https 公网地址（当前：${apiBase}）。` +
        '漏配时产物会静默指向 localhost——宁可构建失败，也不要静默产出一个坏站点。',
    );
  }
  let host = '';
  try {
    host = new URL(apiBase).hostname;
  } catch {
    // 解析不了说明它本就不像 URL——上面 `startsWith('https://')` 已放行到这里，
    // 此时不额外报，避免同一处问题给出两条互相矛盾的提示
    return;
  }
  if (isPlaceholderHost(host)) {
    throw new Error(
      `部署构建要求 ${varName} 是真实对外地址，当前是保留/占位域（${host}，RFC 2606 / 6761）。` +
        '照模板原样部署的产物会把所有请求打到一个不存在的域——宁可构建失败，也不要静默产出一个坏站点。',
    );
  }
}

/* ── _redirects：解析与匹配（CF 语义最小子集） ───────────────────────────── */

export interface RedirectRule {
  source: string;
  destination: string;
  status: number;
}

export function parseRedirects(content: string): RedirectRule[] {
  const rules: RedirectRule[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue; // 畸形行 CF 也会忽略——与平台一致地跳过
    const [source, destination, code] = parts as [string, string, string | undefined];
    rules.push({ source, destination, status: code === undefined ? 302 : Number(code) });
  }
  return rules;
}

/**
 * 按 CF 语义子集匹配一条规则：首条命中生效；splat（`*`）贪婪匹配并替换 `:splat`。
 * @param path 只传**路径**（不含查询串——CF 的匹配本来就不看查询串）。
 */
export function matchRedirect(
  rules: readonly RedirectRule[],
  path: string,
): { destination: string; status: number } | null {
  for (const rule of rules) {
    const star = rule.source.indexOf('*');
    if (star === -1) {
      if (rule.source === path) return { destination: rule.destination, status: rule.status };
      continue;
    }
    const prefix = rule.source.slice(0, star);
    if (path.startsWith(prefix)) {
      const splat = path.slice(prefix.length);
      return { destination: rule.destination.replaceAll(':splat', splat), status: rule.status };
    }
  }
  return null;
}

/* ── tokens.css 生成与 CSS 变量扫描 ─────────────────────────────────────── */

/**
 * 生成 tokens.css：颜色来自 packages/shared（单一来源），
 * 尺寸/字号是本站的 px 平台值（小程序的 rpx 尺寸不可比，见 shared/design-tokens.ts 抬头）。
 * @param generatedBy 生成者标识（写进产物首行注释）。**必须如实**——产物注释撒谎（写着
 *                    「由 build-checkout 生成」实际出自 gen-admin-tokens）会让"该改哪个脚本"
 *                    变成一道考古题（ADR-29：注释/生成物标注必须与事实一致）。
 */
export function renderTokensCss(
  colors: Readonly<Record<string, string>>,
  generatedBy = 'build-checkout',
): string {
  const colorLines = Object.entries(colors).map(([k, v]) => `  --ws-color-${k}: ${v};`);
  return [
    `/* 由 ${generatedBy} 生成（颜色单一来源 = packages/shared/design-tokens.ts），勿手改 */`,
    ':root {',
    ...colorLines,
    '  /* 尺寸/字号：本站（Web px）平台值，与小程序 rpx 体系各自维护（单位不可比） */',
    '  --ws-space: 16px;',
    '  --ws-space-sm: 8px;',
    '  --ws-radius: 10px;',
    '  --ws-font: 16px;',
    '  --ws-font-sm: 14px;',
    '  --ws-font-lg: 22px;',
    '  /* 边框宽度：admin-web 引入（F15③，"border: 1px" 也是写死尺寸）；checkout 暂未用 */',
    '  --ws-border: 1px;',
    '}',
    '',
  ].join('\n');
}

/**
 * 提取 CSS 里的变量：definitions = `--ws-x:` 定义处；references = `var(--ws-x)` 引用处。
 * @why 两种提取分开：`var(--ws-typo)` 拼错不报错、静默失效——必须把"引用的"与"定义的"
 *      对齐才能抓出来（AJ-66 同款教训）。
 * @why 先剥块注释再匹配（AJ-74 同款）：注释里解释规则的文字（"一律走 var(--ws-*)"）
 *      会被当成引用扫出来——剥注释与"鼓励写注释"是一体两面，不剥就是惩罚写注释的人。
 */
export function collectCssVars(css: string, kind: 'definitions' | 'references'): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = kind === 'definitions' ? /(--[\w-]+)\s*:/g : /var\(\s*(--[\w-]+)/g;
  const out = new Set<string>();
  for (const m of stripped.matchAll(re)) {
    const name = m[1];
    if (name !== undefined) out.add(name);
  }
  return [...out];
}

/* ── 品牌名替换 ─────────────────────────────────────────────────────────── */

/** 构建期把 `__BRAND_NAME__` 占位替换成品牌名；无占位时原样返回。 */
export function renderPage(html: string, brand: string = BRAND_NAME): string {
  return html.replaceAll('__BRAND_NAME__', brand);
}

// ── 法务静态页（剩余清单 4-1）────────────────────────────────────────────────

/**
 * 法务页清单：与服务端 `server/src/domain/legal.ts` 的 LEGAL_DOCS 同序同名（单测双向比对）。
 * @why 一份文档一张页、三语言是页内锚点（#zh / #ja / #en），见 domain/legal.ts @why。
 */
export const LEGAL_PAGES = [
  '/legal/terms',
  '/legal/privacy',
  '/legal/refund',
  '/legal/tokushoho',
] as const;

/** 商家字段未配置时显示的文字（不编占位值，见 domain/legal.ts @why）。 */
export const SELLER_PENDING_TEXT =
  '公司登记后公布 / 会社登記後に掲載 / To be published after incorporation';

export const SELLER_TOKENS = [
  'SELLER_NAME',
  'SELLER_REPRESENTATIVE',
  'SELLER_ADDRESS',
  'SELLER_PHONE',
  'SELLER_EMAIL',
] as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 法务页模板 → 成品：品牌名 + 商家字段（`__SELLER_NAME__` 等）构建期替换。
 * @why 构建期而不是运行时：静态站没有服务端，也不该为了五个字段去调 API。
 * @why HTML 转义：值来自部署环境变量，"A&B 株式会社"这种真实名称会把页面弄坏。
 * @limitation 改商家信息要重新构建静态站（与服务端 /terms 的 seller 同源于同名环境变量，两边要一起配）。
 */
export function renderLegalPage(
  html: string,
  env: Partial<Record<(typeof SELLER_TOKENS)[number], string>>,
): string {
  let out = renderPage(html);
  for (const key of SELLER_TOKENS) {
    const v = env[key]?.trim();
    out = out.replaceAll(
      `__${key}__`,
      v === undefined || v === '' ? SELLER_PENDING_TEXT : escapeHtml(v),
    );
  }
  return out;
}
