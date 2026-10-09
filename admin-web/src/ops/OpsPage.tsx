/**
 * 职责：运营配置页（运费分档 + 展示汇率，两块面板并列）。
 *
 * @why 两个面板**各自取数、各自保存**（不共用一个"保存"按钮）：
 *      它们是两张互不相干的表，共用一个按钮的代价是"改了汇率却把运费也提交一遍"——
 *      而运费是整表替换，那等于一次误操作改写两张表。
 *
 * @limitation 一：页面本身**只持有一份 Toast 出口**，其余都是面板的容器——
 *              所有校验与请求都在各自模块里，页面不持有共享的 error / loading。
 *      @why 三个面板的反馈共用这一个 `ToastStack`（审查 2026-10-09，ui/adoption 欠账清单）：
 *           每个面板各挂一个浮层，三摞都固定在右下角会互相重叠（风控页踩过，BlockedUsers 的 `sink` 参数即为此）。
 *      @tradeoff 共用出口 = 共用堆叠规则：同一 kind 只留最新一条，A 面板的新错误会顶掉 B 面板的旧错误、
 *                任一面板成功会清屏。三块面板是同一个人在同一页上依次操作，"只看最新一次操作的结果"正是想要的；
 *                放弃的是"三块各自的旧错误同时可见"。
 *
 * @see ./RatesPanel.tsx；./FxPanel.tsx
 */
import { ToastStack, useToasts } from '../ui/toast.js';
import type { AdminApi } from './api.js';
import { FxPanel } from './FxPanel.js';
import { RatesPanel } from './RatesPanel.js';
import { SalesPausePanel } from './SalesPausePanel.js';

export interface OpsPageProps {
  api: AdminApi;
}

export function OpsPage({ api }: OpsPageProps) {
  const sink = useToasts();
  return (
    <>
      {/* 停售开关放最上面（AJ-384）：开着忘了关 = 店一直关门，必须显眼 */}
      <SalesPausePanel api={api} sink={sink} />
      <RatesPanel api={api} sink={sink} />
      <FxPanel api={api} sink={sink} />
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
    </>
  );
}
