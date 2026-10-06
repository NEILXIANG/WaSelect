// @vitest-environment jsdom
/** 职责：订单页的 CSV 导出按钮（剩余清单 3-3）。 */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, mount, type Mounted } from '../testing/dom.js';
import { ExportBar } from './ExportBar.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

describe('ExportBar（3-3）', () => {
  it('🔴 点"导出报关清单" → 请求 customs，把返回的 csv 存成同名文件（Blob + a.download）', async () => {
    const paths: string[] = [];
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b: Blob) => (blobs.push(b), 'blob:x'),
      revokeObjectURL: () => undefined,
    });
    const clicked: string[] = [];
    const api = (req: { path: string }): Promise<unknown> => {
      paths.push(req.path);
      return Promise.resolve({ filename: 'customs-20261006.csv', csv: '﻿a\r\n1\r\n' });
    };
    mounted = await mount(
      createElement(ExportBar, {
        api: api as never,
        onDownload: (name: string) => clicked.push(name),
      }),
    );
    await click(button(mounted.el, '导出报关清单'));
    expect(paths).toEqual(['/api/v1/admin/exports/customs']);
    expect(clicked).toEqual(['customs-20261006.csv']);
    expect(blobs[0]?.type).toBe('text/csv;charset=utf-8');
  });

  it('🔴 响应缺 csv / filename → 报错，不下载（扫描 A-07）', async () => {
    const clicked: string[] = [];
    const api = (): Promise<unknown> => Promise.resolve({ filename: 'x.csv' });
    mounted = await mount(
      createElement(ExportBar, {
        api: api as never,
        onDownload: (name: string) => clicked.push(name),
      }),
    );
    await click(button(mounted.el, '导出订单总表'));
    expect(mounted.el.textContent).toContain('形状');
    expect(clicked).toEqual([]);
  });

  it('失败 → 显示错误文案，不触发下载', async () => {
    const clicked: string[] = [];
    const api = (): Promise<unknown> => Promise.reject(new ApiError(50000, '服务器开小差了', 't'));
    mounted = await mount(
      createElement(ExportBar, {
        api: api as never,
        onDownload: (name: string) => clicked.push(name),
      }),
    );
    await click(button(mounted.el, '导出待采购清单'));
    expect(mounted.el.textContent).toContain('服务器开小差了');
    expect(clicked).toEqual([]);
  });
});
