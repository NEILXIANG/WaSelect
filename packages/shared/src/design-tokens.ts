/**
 * 职责：跨端 design token 的**颜色**单一来源（ADR-28：UI 不写死）。
 *
 * @why 只共享**颜色**：尺寸单位跨平台不可比（小程序 rpx / Web px），
 *      强行共享会让某端拿到错误单位的值；颜色是单位无关的，也是改版时
 *      最容易"改了一端忘了另一端"的东西。
 *
 * @limitation 小程序 `app.wxss` 仍是手写的另一份（WXSS 不由构建生成）——
 *              两侧颜色漂移由 `scripts/checkout-build-lib.unit.test.ts` 的同源断言钉住：
 *              改一边不改另一边 → gate 红。
 * @limitation S1（2026-10-01）后 `app.wxss` 里旧名的 token 全部改成**别名**
 *              （`--ws-color-bg: var(--ws-canvas)`），所以同源断言比的是
 *              **别名终点的那个 token 的值**，不是旧名那一行字面量。
 *              改这里的值时必须同时改 `app.wxss` 里对应的新 token，否则 gate 红。
 *
 * @see miniprogram/app.wxss（五色同源）；scripts/checkout-build-lib.ts（tokens.css 生成）
 */

/**
 * 调色板。新增颜色必须给它一个**说明用途**的名字（同 app.wxss 的档位纪律）。
 *
 * ⚠️ S1 迁移（2026-10-01）：五个对账色已切到设计体系的暖中性色板，
 *    与 `app.wxss` 的对应关系（旧名 → 新 token）：
 *      bg → --ws-canvas｜card → --ws-surface｜fg → --ws-ink｜muted → --ws-ink-mute｜error → --ws-danger
 *    @why 连 `success` 一起对齐：否则"小程序里的成功色（--ws-success）"与
 *         "支付成功页的成功色"是两个绿，用户在付款回跳的那一刻会看到颜色跳变——
 *         这恰好是整个流程里**最需要连贯**的一屏。
 */
export const WS_COLORS = {
  bg: '#fbf9f5',
  card: '#ffffff',
  fg: '#2b2a27',
  muted: '#8f8a80',
  error: '#a2503f',
  /** 支付完成等正向状态。与小程序 `--ws-success` 同值（S1 起两侧对齐）。 */
  success: '#5e7256',
  /** 需要处理（待发货 / 退款中）的徽章色（AJ-400）。与小程序 `--ws-warn` 同值。 */
  warn: '#a67c4e',
  /** 进行中、无需处理（已发货 / 已签收）的徽章色（AJ-400，管理端首用；小程序暂无对应 token）。 */
  info: '#56708a',
} as const;

export type WsColorName = keyof typeof WS_COLORS;

/* ── 管理端主题（AJ-411，Material Design 3 角色）──────────────────────────────
 *
 * @why 管理端单独一套色，不动上面的 WS_COLORS：WS_COLORS 是**买家**看到的品牌色（D1 轻奢日系暖色，
 *      小程序 / 支付页 / 法务页三处同源），管理端是运营的内部工具，用户要求"有科技感、参考 Google 设计原则"。
 *      两个受众、两种目标，共用一份色板只会让其中一方被迫妥协；分开后改管理端不可能误伤买家端。
 *      ⚠️ AJ-412（2026-10-09 用户反馈「Google 配色风格不好」）：**色值回到品牌暖色系**（墨色主色 / 米白底 / 米色选中），
 *      布局与交互仍按 M3（导航轨、状态层、焦点环、动效、按钮层级）。角色结构不变，只换色值。
 * @why 用 M3 的**角色名**（primary / on-primary / surface-container-low …）而不是用途名：
 *      角色天然成对（X 与 on-X），对比度检查就可以按"角色对"机器化（ADMIN_CONTRAST_PAIRS）。
 * @why 色值是**手调**的（AJ-412 起从品牌 WS_COLORS 同色相派生，只在对比度不足处加深），不是 Material Theme Builder 的导出物：
 *      不引入第三方生成工具（完全自研），每个值都过了下面的对比度清单（admin-theme.unit.test.ts 机器校验）。
 * @limitation 只有浅色一套；深色模式延期（AJ-411 反向风险 / 遗留）。
 * @limitation `success / warn / info` 不是 M3 标准角色（M3 只有 error），是本项目对徽章 / 提示的扩展。
 */
export const ADMIN_COLORS = {
  /** 主按钮 / 选中 / 焦点环：沿用品牌墨色（WS_COLORS.fg），与改版前的实心按钮同色。 */
  primary: '#2b2a27',
  'on-primary': '#ffffff',
  'primary-container': '#ece5d8',
  'on-primary-container': '#2b2a27',
  secondary: '#6b6457',
  'on-secondary': '#ffffff',
  /** 导航选中项的胶囊底色（M3 active indicator），取品牌米色。 */
  'secondary-container': '#e8e0d0',
  'on-secondary-container': '#2b2a27',
  /** 第三色取品牌 info 蓝灰（改版前「已发货」徽章色）。 */
  tertiary: '#56708a',
  'on-tertiary': '#ffffff',
  'tertiary-container': '#dfe7ef',
  'on-tertiary-container': '#1f3346',
  /** 页面底色：品牌米白（WS_COLORS.bg）。 */
  surface: '#fbf9f5',
  'surface-container-lowest': '#ffffff',
  'surface-container-low': '#f5f1ea',
  'surface-container': '#efeae1',
  'surface-container-high': '#e9e3d8',
  'surface-container-highest': '#e3dccf',
  'on-surface': '#2b2a27',
  /** 次要文字：品牌 muted（#8f8a80）同色相加深到过 AA——原值对白约 3.3:1，新手看不清。 */
  'on-surface-variant': '#5f5a51',
  /** 输入框描边、占位符：同色相，过 4.5:1。 */
  outline: '#736d61',
  /** 分隔线、表格行线（装饰性）。 */
  'outline-variant': '#d9d2c5',
  /** 品牌 error（#a2503f）同色相略加深：弹层底上原值 4.38 < 4.5（admin-theme.unit 实测）。 */
  error: '#984a3a',
  'on-error': '#ffffff',
  'error-container': '#f6e2dc',
  'on-error-container': '#4a1d14',
  /** 品牌 success（#5e7256）同色相略加深：徽章底上原值 4.48 < 4.5（admin-theme.unit 实测）。 */
  success: '#566a4f',
  /** 品牌 warn（#a67c4e）作文字对比不足，同色相加深。 */
  warn: '#85602f',
  /** 品牌 info（#56708a）同色相略加深：徽章底上原值 4.42 < 4.5（admin-theme.unit 实测）。 */
  info: '#4e667e',
  /** 遮罩与阴影的基色（透明度在使用处给，见 admin-tokens-lib）。 */
  scrim: '#000000',
  shadow: '#2b2a27',
} as const;

export type AdminColorRole = keyof typeof ADMIN_COLORS;

/**
 * 旧名 → M3 角色：组件里 100 多处 `var(--ws-color-*)` 不必逐处改，换主题只在 token 层发生。
 * @why 键集合与 WS_COLORS 一致（类型钉住）：少映射一个，管理端那一类样式就静默失效。
 */
export const ADMIN_LEGACY_ALIASES: Readonly<Record<WsColorName, AdminColorRole>> = {
  bg: 'surface',
  card: 'surface-container-lowest',
  fg: 'on-surface',
  muted: 'on-surface-variant',
  error: 'error',
  success: 'success',
  warn: 'warn',
  info: 'info',
};

/**
 * 管理端实际用到的"前景 / 背景"组合与最低对比度（WCAG 2.x：正文 4.5，界面元素 / 大字 3）。
 * @why 清单是**使用处**的事实，不是"所有角色两两组合"：新增一种组合（比如把 warn 字放到 container 底上）
 *      就在这里加一行，`admin-theme.unit.test.ts` 会算出它过不过线。
 * @limitation 徽章底色是 `color-mix(… 12%, 白)`，这里按同样的混色算（mixWithWhite），
 *             与 CSS 的 sRGB 混色同口径；浏览器混色的舍入可能差 ±1 个色阶，对比度影响 < 0.05。
 */
export const ADMIN_CONTRAST_PAIRS: ReadonlyArray<{
  fg: AdminColorRole;
  bg: AdminColorRole | { tint: AdminColorRole; percent: number };
  min: 3 | 4.5;
  use: string;
}> = [
  { fg: 'on-primary', bg: 'primary', min: 4.5, use: '主按钮文字' },
  { fg: 'on-error', bg: 'error', min: 4.5, use: '危险主按钮文字' },
  { fg: 'on-primary-container', bg: 'primary-container', min: 4.5, use: '主色容器文字' },
  {
    fg: 'on-secondary-container',
    bg: 'secondary-container',
    min: 4.5,
    use: '导航选中项 / 选中筛选标签',
  },
  { fg: 'on-tertiary-container', bg: 'tertiary-container', min: 4.5, use: '第三色容器文字' },
  { fg: 'on-error-container', bg: 'error-container', min: 4.5, use: '错误容器文字' },
  { fg: 'on-surface', bg: 'surface', min: 4.5, use: '正文（页面底）' },
  { fg: 'on-surface', bg: 'surface-container-low', min: 4.5, use: '正文（卡片 / 侧栏）' },
  { fg: 'on-surface', bg: 'surface-container-high', min: 4.5, use: '正文（弹层）' },
  { fg: 'on-surface-variant', bg: 'surface', min: 4.5, use: '次要文字（页面底）' },
  {
    fg: 'on-surface-variant',
    bg: 'surface-container-low',
    min: 4.5,
    use: '次要文字 / 表头 / 未选中导航',
  },
  {
    fg: 'on-surface-variant',
    bg: 'surface-container-lowest',
    min: 4.5,
    use: '次要文字（统计卡 / 输入框）',
  },
  {
    fg: 'on-surface-variant',
    bg: 'surface-container-high',
    min: 4.5,
    use: '次要文字（弹层）/ 禁用按钮文字',
  },
  {
    fg: 'on-surface-variant',
    bg: 'surface-container-highest',
    min: 4.5,
    use: '禁用按钮文字（最深底）',
  },
  {
    fg: 'primary',
    bg: 'surface-container-low',
    min: 4.5,
    use: '文字按钮 / 描边按钮 / 链接（卡片上）',
  },
  { fg: 'primary', bg: 'surface-container-lowest', min: 4.5, use: '文字按钮（白底）' },
  { fg: 'primary', bg: 'surface-container-high', min: 4.5, use: '文字按钮（弹层上）' },
  { fg: 'error', bg: 'surface-container-low', min: 4.5, use: '错误文字（卡片上）' },
  { fg: 'error', bg: 'surface-container-high', min: 4.5, use: '危险弹层标题' },
  { fg: 'success', bg: 'surface-container-low', min: 4.5, use: '成功文字' },
  { fg: 'warn', bg: 'surface-container-low', min: 4.5, use: '提醒文字' },
  { fg: 'outline', bg: 'surface-container-lowest', min: 4.5, use: '占位符（白底输入框）' },
  { fg: 'outline', bg: 'surface-container-low', min: 3, use: '输入框 / 描边按钮的边框' },
  { fg: 'primary', bg: 'surface', min: 3, use: '键盘焦点环' },
  { fg: 'primary', bg: 'surface-container-low', min: 3, use: '页签选中指示条' },
  { fg: 'warn', bg: { tint: 'warn', percent: 12 }, min: 4.5, use: '徽章：需要处理 / 待办提醒' },
  { fg: 'info', bg: { tint: 'info', percent: 12 }, min: 4.5, use: '徽章：进行中' },
  { fg: 'success', bg: { tint: 'success', percent: 12 }, min: 4.5, use: '徽章：完成' },
  { fg: 'error', bg: { tint: 'error', percent: 12 }, min: 4.5, use: '徽章：拒付 / 失败' },
  { fg: 'on-surface', bg: 'surface-container-highest', min: 4.5, use: '徽章：中性' },
  { fg: 'on-surface-variant', bg: 'surface-container-high', min: 4.5, use: '徽章：弱化' },
];

/** `#rrggbb` → WCAG 相对亮度。 */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x 对比度（1～21），只收 `#rrggbb`（简写与带透明度的形状直接抛错，不猜）。 */
export function contrastRatio(a: string, b: string): number {
  for (const h of [a, b]) {
    if (!/^#[0-9a-f]{6}$/i.test(h)) throw new Error(`contrastRatio 只收 #rrggbb：${h}`);
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB 下把 `hex` 按 percent% 掺进白色（同 CSS `color-mix(in srgb, X p%, #fff)`）。 */
export function mixWithWhite(hex: string, percent: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const p = percent / 100;
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) =>
      Math.round(v * p + 255 * (1 - p))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
