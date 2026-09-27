/**
 * 职责：运营配置页（运费分档 + 展示汇率，两块面板并列）。
 *
 * @why 两个面板**各自取数、各自保存**（不共用一个"保存"按钮）：
 *      它们是两张互不相干的表，共用一个按钮的代价是"改了汇率却把运费也提交一遍"——
 *      而运费是整表替换，那等于一次误操作改写两张表。
 *
 * @limitation 一：页面本身**没有状态**，只是两个面板的容器——
 *              所有校验与请求都在各自模块里，页面不持有共享的 error / loading。
 *
 * @see ./RatesPanel.tsx；./FxPanel.tsx
 */
import type { AdminApi } from './api.js';
import { FxPanel } from './FxPanel.js';
import { RatesPanel } from './RatesPanel.js';

export interface OpsPageProps {
  api: AdminApi;
}

export function OpsPage({ api }: OpsPageProps) {
  return (
    <>
      <RatesPanel api={api} />
      <FxPanel api={api} />
    </>
  );
}
