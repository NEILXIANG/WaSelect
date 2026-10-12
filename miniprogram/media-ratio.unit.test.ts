/**
 * 职责：首页两处宽幅图位的比例与图片规格对得上——轮播 2.5:1（后台 Banner 规格 1500×600）、商品卡 4:3。
 *
 * @why 真实事故（2026-10-12 用户截图）：
 *      ① 轮播框 686rpx × 320rpx ≈ 2.14:1，而后台提示运营做 2.5:1 的图——`aspectFill` 把图放大到撑满高度，
 *         左右各裁掉约 57rpx，Banner 上靠边的字（"北海道限定"的"北"）被切掉；
 *      ② 商品卡图位 686rpx × 260rpx ≈ 2.6:1，真实商品照片多是正方形，上下两截被裁（用户选定改 4:3，jp D-84）。
 *      两处都是"高度 token 与图片规格各写一处、没人对过"，jsdom 看不到布局——所以把比例写成断言。
 * @limitation 按 app.wxss 里的 token 字面量算（750rpx 屏宽 − 两侧 `--ws-space-gutter`）；
 *             哪天图位不再是"屏宽减两侧边距"，这里要跟着改。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'app.wxss'), 'utf8');
const token = (name: string): number => {
  const m = new RegExp(`--${name}:\\s*(\\d+)rpx`).exec(css);
  if (m === null) throw new Error(`app.wxss 里没有 --${name}`);
  return Number(m[1]);
};
const width = 750 - 2 * token('ws-space-gutter');

describe('首页图位比例', () => {
  it('🔴 轮播是 2.5:1（与后台 Banner 规格 1500×600 一致，图不被左右裁）', () => {
    expect(width / token('ws-banner-h')).toBeCloseTo(2.5, 1);
  });

  it('🔴 商品卡图位是 4:3（正方形商品照片只裁一小条）', () => {
    expect(width / token('ws-scene-h')).toBeCloseTo(4 / 3, 1);
    expect(css).toMatch(/\.ws-media--scene\s*\{[^}]*height:\s*var\(--ws-scene-h\)/);
  });
});
