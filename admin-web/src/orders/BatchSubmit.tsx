/**
 * 职责：批量发货的**提交 + 结果**（AJ-401）——勾选模式与 CSV 导入共用：确认弹层 → 调批量接口 → 逐行结果。
 *
 * @why 最终提交用 ConfirmDialog（危险）且要求**输入本次单数**：批量的后果是一次发出 N 封发货邮件，
 *      单单发货要求重打运单号，批量逐行重打不现实，重打"单数"至少保证运营看清了"这次发几单"
 *      （CSV 里有问题的行会被跳过，单数常常不是她以为的那个数）。
 * @why 结果按**行**显示（成功 / 原因），不只给一个总数：部分成功是常态，运营要知道哪几单还得处理。
 *      原因文案见 ship-batch.ts `describeResult`（与服务端 reason 一一对应）。
 * @why 提交中锁住抽屉的关闭出口（useDrawerBusy）：请求在飞时关掉抽屉，结果就看不到了，运营会再提交一次。
 * @limitation 提交后不自动关抽屉：结果要留给人看；列表由 `onDone` 刷新。再次提交前需关闭重开（结果与输入不混在一起）。
 * @see ./ship-batch.ts；../ui/confirm.tsx；../ui/drawer.tsx
 */
import { useState } from 'react';
import { ConfirmDialog } from '../ui/confirm.js';
import { useDrawerBusy } from '../ui/drawer.js';
import { toastError } from '../ui/toast.js';
import { shipOrdersBatch, type AdminApi, type ShipBatchResult } from './api.js';
import { describeResult, toBatchItems, type BatchRow } from './ship-batch.js';

export interface BatchSubmitProps {
  api: AdminApi;
  rows: readonly BatchRow[];
  /** 提交成功（至少拿到了逐单结果）后：刷新列表、记住承运商等。 */
  onDone: (results: readonly ShipBatchResult[]) => void;
  /** 整次失败（网络 / 400）→ 页面的 Toast（统一反馈出口，ui/adoption 门禁）。 */
  onError: (text: string, traceId: string | undefined) => void;
  /**
   * 行内问题是否已经亮出来（勾选抽屉：首次点提交或编辑过该行之后才亮，验收 2026-10-08）。
   * 默认 true：CSV 预检表本来就逐行显示结果。
   */
  revealed?: boolean;
  /** 还没亮出问题时点了提交 → 先亮出问题、不弹确认（与单单发货"点了才红"同口径）。 */
  onReveal?: () => void;
}

export function BatchSubmit({
  api,
  rows,
  onDone,
  onError,
  revealed = true,
  onReveal,
}: BatchSubmitProps): React.JSX.Element {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<readonly ShipBatchResult[] | null>(null);
  useDrawerBusy(busy);

  const items = toBatchItems(rows);
  const skipped = rows.length - items.length;
  const noOf = new Map(rows.map((r) => [r.orderId ?? '', r.orderNo]));

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await shipOrdersBatch(api, items);
      setResults(res);
      onDone(res);
    } catch (e) {
      const { text, traceId } = toastError(e, '批量发货失败');
      onError(text, traceId);
    } finally {
      setAsking(false);
      setBusy(false);
    }
  };

  if (results !== null) {
    const okCount = results.filter((r) => r.ok).length;
    return (
      <div className="form" aria-label="批量发货结果">
        <p className={okCount === results.length ? 'ok' : 'error'}>
          成功 {okCount} 单，失败 {results.length - okCount} 单
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>订单号</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const d = describeResult(r);
              return (
                <tr key={r.order_id}>
                  <td>{noOf.get(r.order_id) ?? r.order_id}</td>
                  <td className={d.ok ? 'ok' : 'error'}>{d.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="form">
      {revealed && skipped > 0 && (
        <p className="error">有 {skipped} 行有问题，不会提交（见上表）</p>
      )}
      {/* @why 还没亮出问题时 0 单也可点：点一下才知道缺什么（单单发货同口径）；亮出之后 0 单才置灰 */}
      <button
        type="button"
        className="btn"
        data-primary-action
        disabled={busy || (items.length === 0 && revealed)}
        onClick={() => {
          if (!revealed && skipped > 0) {
            onReveal?.();
            return;
          }
          setAsking(true);
        }}
      >
        批量发货 {items.length} 单
      </button>
      {asking && (
        <ConfirmDialog
          spec={{
            title: `将发货 ${String(items.length)} 单：发货后不能再改址，发货邮件立即发给买家`,
            body: '运单号录错只能逐单走「订单修正」改，并会再发一封邮件。有问题的行已跳过。',
            confirmText: '确认批量发货',
            danger: true,
            typeToConfirm: String(items.length),
            typeLabel: '请输入本次发货的单数',
          }}
          busy={busy}
          onConfirm={() => void submit()}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}
