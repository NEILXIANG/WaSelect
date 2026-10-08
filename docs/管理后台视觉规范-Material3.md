# 管理后台视觉规范（Material Design 3 原则，自研实现）

> 范围：**只管理端**（`admin-web/`）。买家端（小程序 / 支付页 / 法务页）的品牌色 `WS_COLORS`（D1 轻奢日系暖色）不动。
> 来由：用户 2026-10-08「UI 风格和交互逻辑要有科技感，参考 Google 的设计原则」。决策记录见 `docs/自主决策记录.md` AJ-411。
> 单一来源：色值 `packages/shared/src/design-tokens.ts`（`ADMIN_COLORS`）；尺寸 / 字号 / 阴影 / 动效 `scripts/admin-tokens-lib.ts`；
> 生成物 `admin-web/src/tokens.css`（`gen-admin-tokens`，不入库）；页面样式 `admin-web/src/app.css`。

## 1. 采纳的原则

| M3 原则 | 本项目落地 |
|---|---|
| 颜色**角色**成对（X / on-X） | `--md-color-*` 角色 token；对比度按角色对机器校验（§3） |
| 色调分层（tonal surfaces）代替粗描边 | 页面 `surface` → 侧栏 / 卡片 `surface-container-low` → 表格 / 统计卡 / 分组卡 `lowest`（白）→ 弹层 `high`；描边只留给输入框与描边按钮 |
| 高度（elevation 0–3） | 只用阴影，不做 M3 的 surface tint：登录卡 / 抽屉 1 级，吸底保存条 2 级，弹层 / Toast 3 级，主按钮悬停 +1 级 |
| 形状刻度 | xs 4（输入框）/ sm 8（筛选标签、Toast）/ md 12（表格、统计卡）/ lg 16（卡片、抽屉）/ xl 28（弹层、登录卡）/ full（按钮、导航胶囊、徽章） |
| 字号刻度 | headline-l 32（KPI 数字）/ headline-s 24（弹层标题）/ title-l 22（卡片标题）/ title-m 16 / body-l 16（输入）/ body-m 14（表格、说明）/ label-l 14（按钮、表头、导航）/ label-m 12（计数）；**不用 label-s 11**（AJ-410：标签 ≥ 12） |
| 状态层 | 悬停叠 8% 字色、按下 10%（`color-mix(in srgb, currentColor 8%, 底色)`）：按钮、导航项、筛选标签、页签、文字按钮、表格行 |
| 焦点指示 | `:focus-visible` 2px 主色外环（鼠标点击不出环）；输入框聚焦 2px 主色边 |
| 动效 | 标准缓动 `cubic-bezier(0.2,0,0,1)`、强调减速 `cubic-bezier(0.05,0.7,0.1,1)`；100 / 200 / 300ms。抽屉滑入、弹层淡入 + 0.94→1 放大、遮罩淡入、Toast 上移淡入；`prefers-reduced-motion` 时全部关闭 |
| 导航抽屉 | 左侧整高 `surface-container-low`；项 = 图标 + 文字，56px 高胶囊；选中 = `secondary-container` 胶囊 + 加粗 + `aria-current="page"` |
| 按钮层级 | filled `.btn`（每屏唯一主动作）/ outlined `.btn-secondary` / outlined 错误色 `.btn-danger-outline` / filled 错误色 `.btn-danger` / text `.link`；全部 ≥ 40px 高 |
| 筛选标签 | `.chip` 未选中描边、选中 `secondary-container` 底 + ✓（颜色不是唯一信号） |
| 数据表 | 白底圆角、表头 `surface-container` 底、行线 `outline-variant`、行悬停状态层、`tabular-nums` |
| 字体 | `"Roboto","Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif`（只用本机已有字体，不下载）；订单号 / 内部编号用等宽栈 |

## 2. 颜色角色（浅色）

| 角色 | 色值 | 用途 |
|---|---|---|
| primary / on-primary | #3451c7 / #ffffff | 主按钮、文字按钮、链接、焦点环、页签指示条 |
| primary-container / on- | #dde1ff / #0f1d5c | 备注时间线的竖线 |
| secondary / on- | #585e71 / #ffffff | （预留） |
| secondary-container / on- | #dce2f9 / #151b2c | 导航选中胶囊、选中筛选标签 |
| tertiary(-container) | #006878 / #aeecfc | （预留，未使用） |
| surface | #f8f9ff | 页面底 |
| surface-container-lowest / low / （默认）/ high / highest | #ffffff / #f2f3fa / #eceef4 / #e6e8ee / #e0e2e9 | 白卡 / 卡片与侧栏 / 表头 / 弹层 / 禁用按钮与中性徽章 |
| on-surface / on-surface-variant | #191c21 / #43474f | 正文 / 次要文字（取代旧 muted #8f8a80，约 3.3:1 → 8.4:1） |
| outline / outline-variant | #6f737b / #c3c6cf | 输入框边框与占位符 / 分隔线 |
| error / on-error / error-container / on- | #ba1a1a / #ffffff / #ffdad6 / #410002 | 错误 |
| success / warn / info（本项目扩展） | #1b6c3a / #8a5100 / #00629d | 徽章与提示 |
| scrim / shadow | #000000 | 遮罩（32%）、阴影（30% / 15%） |

旧名兼容：`--ws-color-bg → surface`、`card → surface-container-lowest`、`fg → on-surface`、`muted → on-surface-variant`、
`error / success / warn / info → 同名角色`（`ADMIN_LEGACY_ALIASES`，键集合与 `WS_COLORS` 由类型与测试钉住）。

## 3. 对比度清单（WCAG 2.x，`packages/shared/src/admin-theme.unit.test.ts` 机器校验）

| 用途 | 前景 | 背景 | 对比度 | 下限 |
|---|---|---|---|---|
| 主按钮文字 | on-primary #ffffff | primary #3451c7 | 6.67 | 4.5 |
| 危险主按钮文字 | on-error #ffffff | error #ba1a1a | 6.46 | 4.5 |
| 导航选中 / 选中筛选标签 | on-secondary-container #151b2c | secondary-container #dce2f9 | 13.30 | 4.5 |
| 正文（页面底 / 卡片 / 弹层） | on-surface #191c21 | surface / low / high | 16.26 / 15.44 / 13.94 | 4.5 |
| 次要文字（页面底 / 卡片 / 白底 / 弹层） | on-surface-variant #43474f | surface / low / lowest / high | 8.87 / 8.42 / 9.32 / 7.61 | 4.5 |
| 禁用按钮文字 | on-surface-variant | highest #e0e2e9 | 7.20 | 4.5 |
| 文字按钮 / 描边按钮 / 链接 | primary | low / lowest / high | 6.03 / 6.67 / 5.45 | 4.5 |
| 错误文字 / 危险弹层标题 | error | low / high | 5.84 / 5.27 | 4.5 |
| 成功 / 提醒文字 | success / warn | low | 5.83 / 5.83 | 4.5 |
| 占位符 | outline #6f737b | lowest | 4.76 | 4.5 |
| 输入框 / 描边按钮边框 | outline | low | 4.30 | 3 |
| 焦点环 / 页签指示条 | primary | surface / low | 6.35 / 6.03 | 3 |
| 徽章 warn / info / success / danger | 色调 | 色调 12% 掺白 | 5.40 / 5.40 / 5.40 / 5.28 | 4.5 |
| 徽章 中性 / 弱化 | on-surface / on-surface-variant | highest / high | 13.20 / 7.61 | 4.5 |
| 第三色 / 主色 / 错误容器文字 | on-*-container | *-container | 13.25 / 12.06 / 13.26 | 4.5 |

新增一种"前景 / 背景"组合 → 在 `ADMIN_CONTRAST_PAIRS` 加一行，测试会算出它过不过线。

## 4. 组件映射（类名不变，只换外观）

| 类 | M3 对应 | 说明 |
|---|---|---|
| `.sidebar` / `.nav-item(-on)` / `.nav-logout` | Navigation drawer | 窄窗口（≤ 56rem）躺平成顶部横排，项高 40 |
| `.panel` / `.panel-head` | Filled card / 卡片头承担 top app bar 角色 | 左标题、右主动作；不另加全局标题栏（会与页内标题重复） |
| `.btn` / `.btn-secondary` / `.btn-danger(-outline)` / `.link` | Filled / Outlined / Text button | 禁用态字色保持 ≥ 4.5（不照搬 M3 的 38%） |
| `.chip(-on)` / `.todo-chip(-due)` | Filter chip | 高 40（M3 是 32） |
| `.tabs` / `.tab(-on)` | Primary tabs | |
| `.badge-*` | 色调标签 | 无描边，色调容器底 |
| `.table` | Data table | 舒适密度、行悬停 |
| `.stat-card` / `.stat-value` | KPI 卡 | 32px 等宽数字 |
| `.input` | Outlined text field（紧凑 40 高） | 不做浮动标签：标签在上方常显，新手不会丢失"这一格填什么" |
| `.drawer` | Modal side sheet | `right` 偏移滑入（不用 transform，见 app.css 注释） |
| `.dialog` | Dialog | 28 圆角、high 底 |
| `.toast` | Snackbar 的位置与动效 | 白底 + 3 级阴影 + 左色条（不用深色反相底） |
| `ui/icons.tsx` | 线形图标 | 自绘 24×24、`currentColor`、`aria-hidden`，旁边一定有文字 |

## 5. 刻意没有照搬的（以及为什么）

- **不引入 Material Web / MUI 等组件库**：完全自研约束（CLAUDE.md），且现有组件行为（确认、抽屉、脏态、回车约定）由管理端 800 余条单元 / 组件用例钉住，换库等于重写 + 重测。
- **不加载 Google Fonts / Roboto 网络字体、不用 Material Symbols 图标字体或拷贝其 SVG**：零外部下载；字体栈只列本机已有字体，Roboto 只在装了的机器上生效。图标自绘。
- **不做 FAB（悬浮操作按钮）**：管理端每页的主动作已在卡片头右侧，FAB 会和右下角 Toast 抢位置，且新手不认识无文字的圆按钮。
- **不做 surface tint（按高度给表面叠主色）**：色调容器已经给出层次，再叠一层会让白卡发蓝、降低表格可读性。
- **不做浮动标签输入框**：标签常显在输入框上方（AJ-410 新手可用性）。
- **禁用态不用 38% 透明字**：约 2.3:1，读不出按钮是什么。
- **筛选标签 / 按钮不用 32px 高**：AJ-410 定的可点区域 ≥ 40px 优先。
- **深色模式暂缓**：token 已分层，技术上只需再生成一组 `prefers-color-scheme: dark` 角色值；但目前没人用深色、也无法在本轮做视觉验收，先不开（AJ-411 遗留）。

## 6. 局限

- 状态层用 `color-mix()`：需 Chrome 111+ / Safari 16.2+ / Firefox 113+，更老的浏览器 hover 无变化（功能与对比度不受影响）。
- 对比度清单只覆盖登记过的组合；页面新写组合没登记，测试管不到（review 项）。
- 视觉效果未在本轮做浏览器截图验收（由用户实机复核）。
