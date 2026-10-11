/**
 * 职责：「打印拣货单与面单信息」页（AJ-407）——拉所选订单的详情，排成一页给浏览器打印（`@media print`，见 app.css）。
 *
 * @why 数据来自现有的 `GET /admin/orders/{id}`（每单一次），**不另开打印接口**：
 *      详情已带采购快照、收件地址、HS / 英文品名，契约 0.6.48 只给行项目补了申报价与重量两列。
 *      打印页本身只读、不写库，按轻量档交付（AJ-407 ④）。
 * @why 整页替换列表（与详情同一做法），不弹层：打印时只剩这一块，列表与侧栏由 print 样式隐藏。
 * @limitation 一：N 单发 N 个请求（并发）；勾选上限是当前页（最多 100 单）。**不打半张**——缺一单的拣货单比打不出来更危险：
 *              有单没取到时一单都不排版、打印按钮禁用。
 * @why 取数失败不再整页退回列表（代理 S1，第二轮审计 2026-10-11）：一次勾几十单，一单网络抖动就把整页作废、
 *      运营只能回列表重新勾一遍。现在列出没取到的单、只重试这几单，已取到的留着。
 * @limitation 二：打印版式（分页、纸张）未在真浏览器 / 真打印机上验证；每单一块 `break-inside: avoid`。
 * @limitation 三：本页内容含收件人 PII，只在浏览器内渲染，不写日志、不进审计（读详情本就不审计，AJ-404 同口径）。
 * @see ./print-view.ts；./OrdersPage.tsx
 */
import { useEffect, useRef, useState } from 'react';
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
  /** 订单 id → 订单号（取数失败的提示里给人看；不给就显示 id）。 */
  labelOf?: (id: string) => string;
}

export function PrintSheet({ api, ids, onBack, onError, onPrint, labelOf }: PrintSheetProps) {
  /** 已取到的详情（按 id）。 */
  const [fetched, setFetched] = useState<ReadonlyMap<string, unknown>>(new Map());
  /** 没取到的单（按勾选顺序）。 */
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  /** 取这几单的详情，合进已取到的；失败的记下来（不整页作废，@see 文件头 @why）。 */
  const fetchSome = async (
    list: readonly string[],
    base: ReadonlyMap<string, unknown>,
  ): Promise<void> => {
    setLoading(true);
    const results = await Promise.allSettled(list.map((id) => getOrder(api, id)));
    if (!live.current) return;
    const merged = new Map(base);
    const miss: string[] = [];
    let firstErr: unknown = undefined;
    results.forEach((r, i) => {
      const id = list[i] as string;
      if (r.status === 'fulfilled') merged.set(id, r.value);
      else {
        miss.push(id);
        if (firstErr === undefined) firstErr = r.reason;
      }
    });
    setFetched(merged);
    setFailed(miss);
    setLoading(false);
    if (miss.length > 0) {
      onError(
        `有 ${miss.length} 单的打印数据没取到：${firstErr instanceof ApiError ? firstErr.message : String(firstErr)}`,
        firstErr instanceof ApiError ? firstErr.traceId : undefined,
      );
    }
  };

  useEffect(() => {
    void fetchSome(ids, new Map());
    // ids 由父组件在点击时冻结（不随列表变化），只取一次
  }, []);

  // 不打半张：全部取齐才排版（@see @limitation 一）
  const model: PrintModel | null =
    !loading && failed.length === 0 ? printModel(ids.map((id) => fetched.get(id))) : null;

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
      {loading && <p className="muted no-print">加载中…</p>}
      {!loading && failed.length > 0 && (
        <div className="warn no-print">
          <p>
            以下 {failed.length} 单的打印数据没取到：
            {failed.map((id) => labelOf?.(id) ?? id).join('、')}。 为避免漏打，取齐之前不能打印。
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void fetchSome(failed, fetched)}
          >
            重试没取到的单
          </button>
        </div>
      )}
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
