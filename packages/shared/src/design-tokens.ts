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
