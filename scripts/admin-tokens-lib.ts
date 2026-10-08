/**
 * 职责：渲染管理端 tokens.css（AJ-411）——Material 3 角色色 + 形状 / 字号 / 高度 / 动效 / 状态层，
 *      再把组件沿用的旧名 `--ws-color-*` 指到角色上。
 *
 * @why 与 checkout 的 `renderTokensCss` 分开：那一份是买家端品牌色（WS_COLORS），支付页仍用它；
 *      管理端换主题不该牵动买家页面的生成物。
 * @why 尺寸类 token（形状、字号、阴影）写在这里而不在 shared：它们是 Web px 平台值，小程序用不到（同 renderTokensCss 口径）。
 * @why 阴影与遮罩的颜色走 `color-mix(… var(--md-color-shadow) …)`：色值仍只在 shared 一处，这里只给透明度。
 * @tradeoff 字号 / 阴影数值照 M3 规范取整数 px，而不是自己发明一套；代价是 M3 的 label-small(11px) 被刻意省略——
 *           AJ-410 定了"标签 ≥ 12px"。
 * @see packages/shared/src/design-tokens.ts（ADMIN_COLORS / ADMIN_LEGACY_ALIASES）；docs/管理后台视觉规范-Material3.md
 */

/** 无单位 / 平台值 token（顺序即输出顺序，便于对照规范文档）。 */
const ADMIN_SCALE: ReadonlyArray<readonly [string, string] | string> = [
  '/* 间距（旧名保留）：4 的倍数 */',
  ['--ws-space', '16px'],
  ['--ws-space-sm', '8px'],
  ['--ws-space-xs', '4px'],
  ['--ws-border', '1px'],
  '/* 形状（M3 shape scale）：旧 --ws-radius 指到 sm */',
  ['--md-shape-xs', '4px'],
  ['--md-shape-sm', '8px'],
  ['--md-shape-md', '12px'],
  ['--md-shape-lg', '16px'],
  ['--md-shape-xl', '28px'],
  ['--md-shape-full', '9999px'],
  ['--ws-radius', 'var(--md-shape-sm)'],
  '/* 字号（M3 type scale 节选；正文 ≥ 14、标签 ≥ 12，AJ-410） */',
  ['--md-type-headline-l', '32px'],
  ['--md-type-headline-s', '24px'],
  ['--md-type-title-l', '22px'],
  ['--md-type-title-m', '16px'],
  ['--md-type-body-l', '16px'],
  ['--md-type-body-m', '14px'],
  ['--md-type-label-l', '14px'],
  ['--md-type-label-m', '12px'],
  ['--ws-font', 'var(--md-type-body-l)'],
  ['--ws-font-sm', 'var(--md-type-body-m)'],
  ['--ws-font-lg', 'var(--md-type-title-l)'],
  [
    '--md-font-plain',
    `'Roboto', 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif`,
  ],
  ['--md-font-mono', `ui-monospace, 'SF Mono', 'Roboto Mono', Menlo, Consolas, monospace`],
  '/* 可点区域下限（AJ-410：≥ 40px） */',
  ['--md-target-min', '40px'],
  ['--md-focus-ring', '2px'],
  '/* 高度（elevation 0–3）：只用阴影，不做 M3 的 surface tint */',
  ['--md-elev-0', 'none'],
  [
    '--md-elev-1',
    '0 1px 2px 0 color-mix(in srgb, var(--md-color-shadow) 30%, transparent), 0 1px 3px 1px color-mix(in srgb, var(--md-color-shadow) 15%, transparent)',
  ],
  [
    '--md-elev-2',
    '0 1px 2px 0 color-mix(in srgb, var(--md-color-shadow) 30%, transparent), 0 2px 6px 2px color-mix(in srgb, var(--md-color-shadow) 15%, transparent)',
  ],
  [
    '--md-elev-3',
    '0 1px 3px 0 color-mix(in srgb, var(--md-color-shadow) 30%, transparent), 0 4px 8px 3px color-mix(in srgb, var(--md-color-shadow) 15%, transparent)',
  ],
  '/* 状态层透明度（M3 state layers） */',
  ['--md-state-hover', '8%'],
  ['--md-state-focus', '10%'],
  ['--md-state-pressed', '10%'],
  ['--md-scrim-opacity', '0.32'],
  '/* 动效（M3 motion）：标准缓动 + 100～300ms */',
  ['--md-ease-standard', 'cubic-bezier(0.2, 0, 0, 1)'],
  ['--md-ease-emphasized-decelerate', 'cubic-bezier(0.05, 0.7, 0.1, 1)'],
  ['--md-duration-short', '100ms'],
  ['--md-duration-medium', '200ms'],
  ['--md-duration-long', '300ms'],
];

export function renderAdminTokensCss(
  colors: Readonly<Record<string, string>>,
  aliases: Readonly<Record<string, string>>,
): string {
  const roleLines = Object.entries(colors).map(([k, v]) => `  --md-color-${k}: ${v};`);
  const aliasLines = Object.entries(aliases).map(
    ([legacy, role]) => `  --ws-color-${legacy}: var(--md-color-${role});`,
  );
  const scaleLines = ADMIN_SCALE.map((e) =>
    typeof e === 'string' ? `  ${e}` : `  ${e[0]}: ${e[1]};`,
  );
  return [
    '/* 由 gen-admin-tokens 生成（管理端主题 = packages/shared/design-tokens.ts 的 ADMIN_COLORS，Material 3 角色；尺寸见 scripts/admin-tokens-lib.ts），勿手改 */',
    ':root {',
    '  color-scheme: light;',
    ...roleLines,
    '  /* 旧名（组件沿用）→ M3 角色 */',
    ...aliasLines,
    ...scaleLines,
    '}',
    '',
  ].join('\n');
}
