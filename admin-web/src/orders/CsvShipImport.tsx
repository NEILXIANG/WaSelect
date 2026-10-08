/**
 * 职责：「导入运单号（CSV）」抽屉（AJ-401）——上传或粘贴 CSV（订单号 / 承运商 / 运单号）→ 预检表 → 确认 → 批量发货。
 *
 * @why 订单号用**人看的单号**（列表第一列 order_no），不是内部 id：CSV 来自承运商后台或运营自己的表格，
 *      里面只会有单号。按单号查订单走列表接口（api.ts `findOrdersByNo`），查到的状态直接参与预检。
 * @why "预检"是单独一步（不是粘贴即查）：粘贴过程中反复查询会打出几十次请求；文本改了预检结果即作废，
 *      必须重新预检才能提交——避免"预检的是旧文本、提交的是新文本"。
 * @why 承运商列可缺：缺列或某行为空时用"默认承运商"（上一次用过的，见 last-carrier.ts）。
 * @limitation 编码只认 UTF-8 / Shift_JIS（ship-batch.ts @limitation 二）；认不出表头时整份文件报错，不猜列。
 * @see ./ship-batch.ts；./BatchSubmit.tsx
 */
import { useRef, useState } from 'react';
import { SHIP_BATCH_MAX, SHIP_MAX_CHARS } from '@waselect/shared';
import { ActionDrawer } from '../ui/drawer.js';
import { useFormDirty } from '../ui/unsaved.js';
import { toastError } from '../ui/toast.js';
import { findOrdersByNo, type AdminApi } from './api.js';
import { BatchSubmit } from './BatchSubmit.js';
import { BatchRowIssues } from './BatchRowIssues.js';
import { readLastCarrier, saveLastCarrier } from './last-carrier.js';
import {
  buildCsvPreview,
  csvOrderNos,
  decodeCsvBytes,
  parseCsvRecords,
  type BatchRow,
} from './ship-batch.js';

export interface CsvShipImportProps {
  api: AdminApi;
  onClose: () => void;
  onDone: () => void;
  /** 查询失败 / 提交整次失败 → 页面的 Toast；文件本身的问题（表头 / 超上限）仍红在输入框下面（字段级）。 */
  onError: (text: string, traceId: string | undefined) => void;
}

export function CsvShipImport({ api, onClose, onDone, onError }: CsvShipImportProps) {
  const [text, setText] = useState('');
  const [carrier, setCarrier] = useState(readLastCarrier);
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  /** 文件级问题（空 / 表头 / 超上限）：属于这份输入，红在输入框下面。 */
  const [fileError, setFileError] = useState('');
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState(false);
  useFormDirty(done ? '' : text, '');

  /**
   * 输入代次：文本或默认承运商一改就 +1。预检在飞时输入变了，回来的结果属于旧输入，丢弃
   * （续作复核修正：原先只在改动时清 rows，在飞的那次预检回来仍会把旧文本的结果填回去）。
   */
  const gen = useRef(0);
  /** 文本或默认承运商一改，旧的预检就作废（@why 第二段）。 */
  const invalidate = (): void => {
    gen.current += 1;
    setRows(null);
  };
  const changeText = (v: string): void => {
    setText(v);
    invalidate();
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    changeText(decodeCsvBytes(new Uint8Array(await file.arrayBuffer())));
  };

  const check = async (): Promise<void> => {
    setFileError('');
    setRows(null);
    const records = parseCsvRecords(text);
    const mine = gen.current;
    setChecking(true);
    try {
      // 表头不对 / 空文件 / 超上限 / 形状不对的单号：不进查询（csvOrderNos @why），文件级错误由 buildCsvPreview 报
      const lookup = await findOrdersByNo(api, csvOrderNos(records));
      if (mine !== gen.current) return;
      const preview = buildCsvPreview(records, lookup, carrier);
      if (preview.error !== '') setFileError(preview.error);
      else setRows(preview.rows);
    } catch (e) {
      const { text, traceId } = toastError(e, '查询订单失败');
      onError(text, traceId);
    } finally {
      setChecking(false);
    }
  };

  return (
    <ActionDrawer wide title="导入运单号（CSV）" onClose={onClose}>
      <p className="muted">
        第一行是表头，需含「订单号」「运单号」两列，「承运商」可选（支持 order_no / carrier /
        tracking_no， 以及 注文番号 / 配送業者 / 追跡番号 等写法）。一次最多 {SHIP_BATCH_MAX} 行。
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="选择 CSV 文件"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <textarea
        className="input"
        aria-label="CSV 内容"
        rows={8}
        value={text}
        placeholder={'order_no,carrier,tracking_no\n261007-7K3QXA,Japan Post,EJ123456789JP'}
        onChange={(e) => changeText(e.target.value)}
      />
      {fileError !== '' && (
        <div className="field-errors" role="alert">
          <span className="error">{fileError}</span>
        </div>
      )}
      <label className="muted">
        默认承运商（承运商列缺失或为空时用）{' '}
        <input
          className="input"
          aria-label="默认承运商"
          maxLength={SHIP_MAX_CHARS.carrier}
          value={carrier}
          onChange={(e) => {
            setCarrier(e.target.value);
            invalidate();
          }}
        />
      </label>
      <button
        type="button"
        className="btn"
        disabled={text.trim() === '' || checking}
        onClick={() => void check()}
      >
        {checking ? '预检中…' : '预检'}
      </button>
      {rows !== null && (
        <>
          <table className="table" aria-label="预检结果">
            <thead>
              <tr>
                <th>行</th>
                <th>订单号</th>
                <th>承运商</th>
                <th>运单号</th>
                <th>问题</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.line}>
                  <td>{r.line}</td>
                  <td>{r.orderNo}</td>
                  <td>{r.carrier}</td>
                  <td>{r.trackingNo}</td>
                  <td>
                    <BatchRowIssues row={r} showOk />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <BatchSubmit
            api={api}
            rows={rows}
            onError={onError}
            onDone={() => {
              setDone(true);
              saveLastCarrier(carrier);
              onDone();
            }}
          />
        </>
      )}
    </ActionDrawer>
  );
}
