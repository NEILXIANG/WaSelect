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
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';
import type { AdminApi } from './api.js';

const EXPORTS = [
  { kind: 'orders', label: '导出订单总表' },
  { kind: 'purchase', label: '导出待采购清单' },
  { kind: 'customs', label: '导出报关清单' },
] as const;

/**
 * 默认下载：链接挂进页面再点、点完移除。
 * @why 扫描 A-01：不挂进 DOM、点完立刻释放 Blob 地址时，Safari 会报 WebKitBlobResource 错误或下载出空文件，
 *      且页面不报任何错；释放推迟到 30 秒后（下载早已开始），见下方 run()。
 * @limitation 真浏览器行为未实测（jsdom 不执行下载）；首次部署后在 Safari / Chrome 各导一次确认。
 */
function defaultDownload(filename: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 导出请求的超时（P2-52）：全量订单表要在服务端拼 CSV，默认 10s 在数据量上来后会先超时——
 * 而超时只是"不等了"，服务端仍在算（client.ts @limitation 二），运营会以为导出坏了反复点。
 */
export const EXPORT_TIMEOUT_MS = 60_000;

/** 释放 Blob 地址前等待的毫秒数（扫描 A-01）。 */
const REVOKE_DELAY_MS = 30_000;

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
      const r = (await api({
        path: `/api/v1/admin/exports/${kind}`,
        timeoutMs: EXPORT_TIMEOUT_MS,
      })) as {
        filename?: unknown;
        csv?: unknown;
      } | null;
      // 扫描 A-07：形状不对就报错，不下载一个叫 undefined、内容是 "undefined" 的文件
      if (typeof r?.filename !== 'string' || typeof r.csv !== 'string') {
        throw new ApiError(NETWORK_ERROR_CODE, '导出响应形状与契约不符', '');
      }
      const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
      onDownload(r.filename, url);
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
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
