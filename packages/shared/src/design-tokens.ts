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
 *
 * @see miniprogram/app.wxss（五色同源）；scripts/checkout-build-lib.ts（tokens.css 生成）
 */

/** 调色板。新增颜色必须给它一个**说明用途**的名字（同 app.wxss 的档位纪律）。 */
export const WS_COLORS = {
  bg: '#f6f6f6',
  card: '#ffffff',
  fg: '#1a1a1a',
  muted: '#8a8a8a',
  error: '#c0392b',
  /** 支付完成等正向状态（checkout 静态页用；小程序侧暂无消费方，不强行同步进 wxss）。 */
  success: '#1e8449',
} as const;

export type WsColorName = keyof typeof WS_COLORS;
