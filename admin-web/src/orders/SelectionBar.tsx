/**
 * 职责：订单列表勾选后的操作条（AJ-407，§4 第 134 行）——「导出所选」三类 CSV + 「打印拣货单与面单信息」。
 *
 * @why 三类导出与顶部 ExportBar **同一个端点、同一个下载函数**（`requestExport`），只多带 `order_ids`：
 *      列与编码永远一致；服务端仍按原规则过滤（待采购 / 报关只出待发货单、测试单不出），
 *      所以导出的行数可能少于勾选数——成功提示里写明"N 单中只有待发货单进待采购 / 报关清单"。
 * @why 按钮全部是次要样式：本页唯一的实心主按钮留给「批量发货」（一屏一个主动作）。
 * @why 反馈走 Toast（ui/adoption 门禁：新组件不写行内反馈）。
 * @limitation 打印按钮只看**列表行**的状态决定是否可点（有 paid 才可点）；真正以详情为准过滤在 print-view。
 * @see ./ExportBar.tsx requestExport；./PrintSheet.tsx；server/src/app/admin-export-routes.ts
 */
import { useState } from 'react';
import { ApiError } from '../api/errors.js';
import type { AdminApi } from './api.js';
import { defaultDownload, requestExport } from './ExportBar.js';

const KINDS = [
  { kind: 'orders', label: '导出所选（订单总表）' },
  { kind: 'purchase', label: '导出所选（待采购）' },
  { kind: 'customs', label: '导出所选（报关）' },
] as const;

export interface SelectionBarProps {
  api: AdminApi;
  /** 勾选的订单 id（按列表顺序）。 */
  ids: readonly string[];
  /** 勾选里待发货（paid）的单数——为 0 时打印不可点。 */
  paidCount: number;
  onPrint: () => void;
  onInfo: (text: string) => void;
  onError: (text: string, traceId: string | undefined) => void;
  /** 测试注入；生产不传。 */
  onDownload?: (filename: string, url: string) => void;
}

export function SelectionBar(p: SelectionBarProps) {
  const [busy, setBusy] = useState(false);
  if (p.ids.length === 0) return null;

  const run = async (kind: string): Promise<void> => {
    setBusy(true);
    try {
      await requestExport(p.api, kind, p.onDownload ?? defaultDownload, p.ids);
      p.onInfo(
        kind === 'orders'
          ? `已导出所选 ${String(p.ids.length)} 单`
          : `已导出：所选 ${String(p.ids.length)} 单中的待发货单（不含测试单）`,
      );
    } catch (e) {
      p.onError(
        `导出失败：${e instanceof ApiError ? e.message : String(e)}`,
        e instanceof ApiError ? e.traceId : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="filters" role="group" aria-label="所选订单操作">
      <span className="muted">已选 {p.ids.length} 单：</span>
      {KINDS.map((k) => (
        <button
          key={k.kind}
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void run(k.kind)}
        >
          {k.label}
        </button>
      ))}
      <button
        type="button"
        className="btn btn-secondary"
        disabled={p.paidCount === 0}
        title={p.paidCount === 0 ? '所选里没有能打印的单' : undefined}
        onClick={p.onPrint}
      >
        打印拣货单与面单信息（{p.paidCount}）
      </button>
      {/* 原因只在悬停里（规律排查 2026-10-12）：按钮灰着、运营看不出为什么 */}
      {/* paidCount 是"能发货"的单数（待发货且不是测试单、没有拒付限制）——原因要照这个说（三天提交复查 2026-10-12） */}
      {p.paidCount === 0 && (
        <span className="muted">所选里没有能打印的单（测试单、有拒付限制的单不打印）</span>
      )}
    </div>
  );
}
