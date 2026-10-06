/**
 * 职责：订单页顶部的三个 CSV 导出按钮（剩余清单 3-3）——订单总表 / 待采购清单 / 报关清单。
 *
 * @why 服务端回 JSON `{filename, csv}`（见 server admin-export-routes.ts @why），这里转成 Blob 交给浏览器下载：
 *      走同一个 api 封装，鉴权过期、trace、错误文案都不用另写。
 * @why `onDownload` 可注入：jsdom 不会真的下载，测试靠它确认"点了哪个文件名"。默认实现是 `<a download>` 点一下。
 * @limitation 导出的是**此刻**的数据，不随页面上的筛选条件变化（订单总表除外的两类固定为"已付款未发货"）。
 * @see ../../../server/src/app/admin-export-routes.ts
 */
import { useState } from 'react';
import { ApiError } from '../api/errors.js';
import type { AdminApi } from './api.js';

const EXPORTS = [
  { kind: 'orders', label: '导出订单总表' },
  { kind: 'purchase', label: '导出待采购清单' },
  { kind: 'customs', label: '导出报关清单' },
] as const;

function defaultDownload(filename: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
}

export interface ExportBarProps {
  api: AdminApi;
  /** 测试注入；生产不传。 */
  onDownload?: (filename: string, url: string) => void;
}

export function ExportBar({ api, onDownload = defaultDownload }: ExportBarProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (kind: string): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const r = (await api({ path: `/api/v1/admin/exports/${kind}` })) as {
        filename: string;
        csv: string;
      };
      const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
      onDownload(r.filename, url);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row2">
      {EXPORTS.map((x) => (
        <button
          key={x.kind}
          type="button"
          className="link"
          disabled={busy}
          onClick={() => void run(x.kind)}
        >
          {x.label}
        </button>
      ))}
      {error !== '' && <span className="error">{error}</span>}
    </div>
  );
}
