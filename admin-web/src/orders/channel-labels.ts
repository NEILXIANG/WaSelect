/**
 * 职责：支付通道代号 → 中文名（全入口点击测试 2026-10-11），订单详情的"支付"一行与时间线的"支付机构"用。
 *
 * @why 原写"mock · 13,680 円"（代号 + 那时的单位字，现为「日元」）"支付机构 mock"——代号运营读不懂。
 *      中文名取设置接口 `GET /admin/settings`
 *      里的 payment_channels（与买家支付页同一份配置表），**不在前端写死通道名**（CLAUDE.md 约束四）。
 * @why 整个页签只取一次（模块级缓存）：中文名改了要重启服务才生效（设置页写着），页签内不会变。
 * @limitation 设置接口只列当前开着的通道；已下线通道的历史订单取不到中文名，原样显示代号（不吞信息）。
 *             取数失败同样退回代号，不挡页面。
 * @why 本文件只放纯函数、不 import React：根目录的接缝 / 旅程测试（test/e2e）要直接调它，
 *      根 tsc 程序一旦引入 React 类型，小程序组件测试（miniprogram-simulate 的 dom）类型检查就报 20 处错（2026-10-12 实测）。
 *      取数 + 缓存的 hook 在 use-channel-labels.ts。
 */
import type { SettingsLike } from '../settings/api.js';

export type ChannelLabels = Readonly<Record<string, string>>;

/** 设置响应 → 代号 → 中文名；形状不对返回空表。 */
export function channelLabelsFrom(settings: SettingsLike | null | undefined): ChannelLabels {
  const out: Record<string, string> = {};
  const groups = Array.isArray(settings?.groups) ? settings.groups : [];
  for (const g of groups) {
    for (const item of Array.isArray(g.items) ? g.items : []) {
      if (item.key !== 'payment_channels' || !Array.isArray(item.value)) continue;
      for (const c of item.value as unknown[]) {
        const rec = typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : {};
        if (
          typeof rec['channel'] === 'string' &&
          typeof rec['label'] === 'string' &&
          rec['label'] !== ''
        ) {
          out[rec['channel']] = rec['label'];
        }
      }
    }
  }
  return out;
}
