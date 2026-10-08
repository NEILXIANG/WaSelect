// @vitest-environment jsdom
/**
 * 职责：设置页组件行为（AJ-404）——分组渲染、只读（页面上没有任何输入框 / 提交按钮）、取数失败走 Toast。
 *
 * @why 断言"没有输入框"：这一页的承诺是只读。哪天有人顺手加了个"编辑"，
 *      运营会以为在这里改 env 就生效了——而 env 只能在部署平台改、改完要重启。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { mount, type Mounted } from '../testing/dom.js';
import { NOT_SET } from './view.js';
import { SettingsPage } from './SettingsPage.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const BODY = {
  generated_at: '2026-10-07T01:00:00.000Z',
  groups: [
    {
      key: 'shop',
      items: [
        {
          key: 'seller_name',
          value: '株式会社ワセレクト',
          source: 'env',
          apply: 'restart',
          env: 'SELLER_NAME',
        },
        {
          key: 'seller_address',
          value: null,
          source: 'env',
          apply: 'restart',
          env: 'SELLER_ADDRESS',
        },
      ],
    },
    {
      key: 'shipping',
      items: [
        { key: 'shipping_rates', value: null, source: 'db', apply: 'immediate', edit_page: 'ops' },
      ],
    },
    {
      key: 'notify',
      items: [{ key: 'sentry_configured', value: false, source: 'env', apply: 'restart' }],
    },
  ],
};

async function open(resp: unknown): Promise<{ el: HTMLElement; paths: string[] }> {
  const paths: string[] = [];
  const api = async (req: { path: string }): Promise<unknown> => {
    paths.push(req.path);
    if (resp instanceof Error) throw resp;
    return resp;
  };
  mounted = await mount(createElement(SettingsPage, { api: api as never }));
  return { el: mounted.el, paths };
}

describe('SettingsPage', () => {
  it('按组渲染：组名、项名、值、生效方式；运费项给运营配置页链接', async () => {
    const { el, paths } = await open(BODY);
    expect(paths).toEqual(['/api/v1/admin/settings']);
    expect(el.querySelector('.title')?.textContent).toBe('设置');
    const titles = [...el.querySelectorAll('.form-card-title')].map((n) => n.textContent);
    expect(titles).toEqual(['店铺信息', '运费', '通知']);
    const rows = [...el.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim()),
    );
    // AJ-410 / N31：主文案改白话；环境变量名收进第四格的折叠「技术信息」（原第三格直接写 `环境变量 SELLER_NAME`）
    expect(rows).toEqual([
      [
        '商家名称',
        '株式会社ワセレクト',
        '技术人员在服务器上修改 · 改后需重启',
        '技术信息环境变量 SELLER_NAME',
      ],
      [
        '商家地址',
        NOT_SET,
        '技术人员在服务器上修改 · 改后需重启',
        '技术信息环境变量 SELLER_ADDRESS',
      ],
      ['运费分档', '在「运营配置」页查看与修改', '在后台修改 · 立即生效', '技术信息存放在数据库'],
      [
        '错误上报（Sentry）',
        '未开通，上线前请让技术人员配置',
        '技术人员在服务器上修改 · 改后需重启',
        '技术信息部署环境变量',
      ],
    ]);
    // 环境变量名只在折叠的 <details> 里，不在主文案里
    for (const tr of el.querySelectorAll('tbody tr')) {
      const main = [...tr.querySelectorAll('td')].slice(0, 3).map((td) => td.textContent ?? '');
      expect(main.join('')).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
    expect(el.querySelector('a[href="#/ops"]')).not.toBeNull();
  });

  it('只读：页面上没有输入框、没有提交按钮', async () => {
    const { el } = await open(BODY);
    expect(el.querySelectorAll('input, select, textarea').length).toBe(0);
    expect([...el.querySelectorAll('button')].filter((b) => !b.closest('.toast'))).toEqual([]);
  });

  it('取数失败 → Toast 报错（带 trace），不渲染半截分组', async () => {
    const { el } = await open(new ApiError(50000, '服务器内部错误', 'trace-xyz'));
    expect(el.querySelector('.toast-error')?.textContent).toContain('服务器内部错误');
    expect(el.querySelector('.toast-error')?.textContent).toContain('trace-xyz');
    expect(el.querySelectorAll('.form-card').length).toBe(0);
  });
});
