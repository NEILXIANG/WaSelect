/**
 * 职责：「打印拣货单与面单信息」页（AJ-407）——拉所选订单的详情，排成一页给浏览器打印（`@media print`，见 app.css）。
 *
 * @why 数据来自现有的 `GET /admin/orders/{id}`（每单一次），**不另开打印接口**：
 *      详情已带采购快照、收件地址、HS / 英文品名，契约 0.6.48 只给行项目补了申报价与重量两列。
 *      打印页本身只读、不写库，按轻量档交付（AJ-407 ④）。
 * @why 整页替换列表（与详情同一做法），不弹层：打印时只剩这一块，列表与侧栏由 print 样式隐藏。
 * @limitation 一：N 单发 N 个请求（并发）；勾选上限是当前页（20 单），量级可接受。任一单失败整页报错（Toast），
 *              不打半张——缺一单的拣货单比打不出来更危险。
 * @limitation 二：打印版式（分页、纸张）未在真浏览器 / 真打印机上验证；每单一块 `break-inside: avoid`。
 * @limitation 三：本页内容含收件人 PII，只在浏览器内渲染，不写日志、不进审计（读详情本就不审计，AJ-404 同口径）。
 * @see ./print-view.ts；./OrdersPage.tsx
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { getOrder, type AdminApi } from './api.js';
import { PRINT_NOTICE, printModel, type PrintModel } from './print-view.js';

export interface PrintSheetProps {
  api: AdminApi;
  /** 勾选的订单 id（按勾选时列表顺序）。 */
  ids: readonly string[];
  onBack: () => void;
  onError: (text: string, traceId: string | undefined) => void;
  /** 测试注入；生产为 `window.print`。 */
  onPrint?: () => void;
}

export function PrintSheet({ api, ids, onBack, onError, onPrint }: PrintSheetProps) {
  const [model, setModel] = useState<PrintModel | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all(ids.map((id) => getOrder(api, id)))
      .then((orders) => {
        if (live) setModel(printModel(orders));
      })
      .catch((e: unknown) => {
        if (!live) return;
        onError(
          `打印数据加载失败：${e instanceof ApiError ? e.message : String(e)}`,
          e instanceof ApiError ? e.traceId : undefined,
        );
        onBack();
      });
    return () => {
      live = false;
    };
    // ids 由父组件在点击时冻结（不随列表变化），只取一次
  }, []);

  return (
    <section className="panel print-sheet">
      <header className="panel-head no-print">
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          返回列表
        </button>
        <button
          type="button"
          className="btn"
          disabled={model === null || model.orders.length === 0}
          onClick={() => (onPrint ?? (() => window.print()))()}
        >
          打印
        </button>
      </header>
      <h1 className="title">拣货单与面单信息</h1>
      <p className="muted">{PRINT_NOTICE}</p>
      {model === null && <p className="muted no-print">加载中…</p>}
      {model !== null && model.skipped.length > 0 && (
        <p className="warn no-print">
          以下 {model.skipped.length} 单不是待发货，未列入：{model.skipped.join('、')}
        </p>
      )}
      {model?.orders.map((o) => (
        <article key={o.id} className="print-order" aria-label={`打印 ${o.orderNo}`}>
          <h2 className="print-order-no">订单 {o.orderNo}</h2>
          <h3>拣货</h3>
          <table className="table">
            <thead>
              <tr>
                <th>商品</th>
                <th>日文原名</th>
                <th>JAN</th>
                <th>采购来源</th>
                <th>数量</th>
              </tr>
            </thead>
            <tbody>
              {o.pick.map((p, i) => (
                <tr key={i}>
                  <td>{p.title}</td>
                  <td>{p.titleJa}</td>
                  <td>{p.jan}</td>
                  <td>{p.source}</td>
                  <td>{p.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>面单信息</h3>
          <div className="print-address">
            <div>{o.recipient}</div>
            {o.addressLines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
            <div>Tel: {o.phone}</div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Description</th>
                <th>HS</th>
                <th>Qty</th>
                <th>Weight</th>
                <th>Value (USD)</th>
              </tr>
            </thead>
            <tbody>
              {o.declared.map((d, i) => (
                <tr key={i}>
                  <td>{d.desc}</td>
                  <td>{d.hs}</td>
                  <td>{d.qty}</td>
                  <td>{d.weightText}</td>
                  <td>{d.valueText}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>申报合计：{o.declaredTotalText}</p>
        </article>
      ))}
    </section>
  );
}
