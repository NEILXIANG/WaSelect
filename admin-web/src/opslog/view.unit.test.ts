/** 职责：运营日志页的纯函数（剩余清单 3-2）。 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTION_LABELS, RECONCILE_CLASS_LABELS, auditRows, reconciliationView } from './view.js';

describe('auditRows', () => {
  it('时间转 JST、缺失字段给 "—"、状态码 ≥400 标为失败', () => {
    const rows = auditRows([
      {
        id: 3,
        actor: 'admin:u-a',
        action: 'POST /api/v1/admin/orders/:id/refund',
        target: 'o-1',
        status_code: 500,
        created_at: '2026-10-05T15:00:00.000Z',
      },
      {
        id: 2,
        actor: 'cli:admin-create',
        action: 'CLI admin.create',
        created_at: '2026-10-05T00:00:00.000Z',
      },
    ]);
    expect(rows[0]).toMatchObject({
      timeText: '2026-10-06 00:00',
      targetText: 'o-1',
      statusText: '500',
      failed: true,
    });
    expect(rows[1]).toMatchObject({ targetText: '—', statusText: '—', failed: false });
  });

  // 三端模拟测试 2026-10-11（用户要求：运营看不懂的 id 不进正文）：长 id 缩短显示，全文进 targetTitle（悬停）
  it('🔴 对象是 36 位 id → 正文缩短、悬停给全文；短的原样', () => {
    const [r] = auditRows([
      {
        id: 1,
        actor: 'admin:u-a',
        action: 'POST /api/v1/admin/orders/:id/ship',
        target: 'ord-0f3508cf-69ac-4599-a99d-62ae4cdf8058',
        status_code: 200,
        created_at: '2026-10-05T15:00:00.000Z',
      },
    ]);
    expect(r).toMatchObject({
      targetText: 'ord-0f3508cf…',
      targetTitle: 'ord-0f3508cf-69ac-4599-a99d-62ae4cdf8058',
    });
  });

  it('形状不对的元素（非对象）被跳过，不渲染成一行 undefined', () => {
    expect(auditRows([null, 'x', { id: 1, actor: 'a', action: 'b', created_at: '' }])).toHaveLength(
      1,
    );
  });
});

describe('auditRows：中文操作名与操作人邮箱（三端联动 UI 模拟 2026-10-08）', () => {
  it('认得的 action 显示中文、保留原文；有邮箱显示邮箱；认不出的原样', () => {
    const [a, b] = auditRows([
      {
        id: 1,
        actor: 'admin:adm-1',
        actor_email: 'ops@example.com',
        action: 'POST /admin/users/:id/unblock',
        created_at: '',
      },
      { id: 2, actor: 'admin:adm-1', action: 'POST /admin/new-thing', created_at: '' },
    ]);
    expect([a?.actor, a?.action, a?.actionRaw]).toEqual([
      'ops@example.com',
      '解除拉黑',
      'POST /admin/users/:id/unblock',
    ]);
    expect([b?.actor, b?.action]).toEqual(['admin:adm-1', 'POST /admin/new-thing']);
  });
});

describe('ACTION_LABELS：分类操作（AJ-491）', () => {
  it('新建 / 编辑 / 删除分类显示中文，不显示接口路径', () => {
    expect(ACTION_LABELS['POST /admin/categories']).toBe('新建分类');
    expect(ACTION_LABELS['PUT /admin/categories/:key']).toBe('编辑分类');
    expect(ACTION_LABELS['DELETE /admin/categories/:key']).toBe('删除分类');
  });
});

describe('reconciliationView', () => {
  // AJ-410：「对账」改白话「自动核对」
  it('没跑过 → 明确说"还没有自动核对记录"', () => {
    expect(reconciliationView(null)).toEqual({
      headline: '还没有自动核对记录',
      ok: false,
      summary: '',
      rows: [],
    });
  });

  it('零异常 → ok，标题带 JST 时间', () => {
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: { stuck_refunds: 0 },
      samples: {},
    });
    expect(v).toEqual({
      headline: '最近一次自动核对 2026-10-06 03:00：无异常',
      ok: true,
      summary: '',
      rows: [],
    });
  });

  // 三端模拟测试 2026-10-11（用户截图：一墙 ord-… 链接，看不出先做什么、谁来做）——改成成熟后台的异常看板：
  //   每类一行：说清怎么处理、谁处理（运营 / 技术人员 / 留意即可），能筛的给「去处理」；涉及钱的排最前；示例最多 3 个
  it('🔴 有异常 → 每类一行：中文名、数量、怎么处理、谁处理、去处理入口；只列非零类；钱相关的排在前面', () => {
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: {
        order_mail_unsent: 71,
        after_sales_waiting: 30,
        late_paid_unrefunded: 3,
        stuck_refunds: 0,
      },
      samples: {},
    });
    expect(v.ok).toBe(false);
    expect(v.headline).toContain('3 类异常');
    expect(v.rows.map((r) => [r.key, r.count, r.owner, r.href])).toEqual([
      ['late_paid_unrefunded', 3, 'ops', '#/orders?attention=late_paid'],
      ['after_sales_waiting', 30, 'ops', '#/orders?attention=after_sale'],
      ['order_mail_unsent', 71, 'tech', ''],
    ]);
    expect(v.rows[0]?.label).toBe(RECONCILE_CLASS_LABELS['late_paid_unrefunded']);
    expect(v.rows[0]?.advice).toContain('退款');
    expect(v.summary).toBe('2 类需要运营处理，1 类请转技术人员');
  });

  it('不认识的类名原样显示、归"请转技术人员"（看得见，不静默丢）', () => {
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: { brand_new_class: 1 },
      samples: { brand_new_class: ['x'] },
    });
    expect(v.rows.map((r) => [r.label, r.owner, r.samples])).toEqual([
      ['brand_new_class', 'tech', [{ label: 'x', href: '' }]],
    ]);
  });

  it('🔴 示例最多 3 个、其余计数；认出订单 id 链到订单详情（含 order.paid: / evt_late_ 前缀），pay- 缩短不给链接', () => {
    const id = (n: number): string => `ord-0923${String(n)}ad4-ddc6-4818-802b-a435108392cf`;
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: { order_mail_unsent: 71, late_paid_unrefunded: 1, dangling_initiated_payments: 1 },
      samples: {
        order_mail_unsent: [1, 2, 3, 4, 5].map((n) => `order.paid:${id(n)}`),
        late_paid_unrefunded: [`evt_late_${id(7)}`],
        dangling_initiated_payments: ['pay-6cfc82a4-3ced-4b19-a89a-9b830e179960'],
      },
    });
    const mail = v.rows.find((r) => r.key === 'order_mail_unsent');
    expect(mail?.samples).toEqual(
      [1, 2, 3].map((n) => ({ label: `ord-0923${String(n)}ad4…`, href: `#/orders/${id(n)}` })),
    );
    expect(mail?.more).toBe(68);
    expect(v.rows.find((r) => r.key === 'late_paid_unrefunded')?.samples).toEqual([
      { label: 'ord-09237ad4…', href: `#/orders/${id(7)}` },
    ]);
    expect(v.rows.find((r) => r.key === 'dangling_initiated_payments')).toMatchObject({
      owner: 'watch',
      samples: [{ label: 'pay-6cfc82a4…', href: '' }],
    });
  });

  /**
   * AJ-425：类名清单不再手抄——直接从服务端 `daily-reconciliation.ts` 收集所有 `key: '…'` 字面量（双向比对）。
   * @why 手抄那份曾漏了审核模式三类（review_mode_no_deadline / _expired / _closing），运营日志页一直原样显示英文，
   *      而测试是绿的：它只核对"管理端这份清单 = 测试里抄的那份"，从没和服务端对过（统一结论 U7 副本即负债）。
   * @limitation 只认 `key: '字面量'` 形态；`review_mode` 是"未开启 / 无异常"的占位类（count 恒 0，永不显示），排除。
   */
  it('🔴 服务端对账的每一类都配了中文名，管理端也没有多出来的', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../../../server/src/app/daily-reconciliation.ts'),
      'utf8',
    );
    const serverKeys = [
      ...new Set([...src.matchAll(/key: '([a-z0-9_]+)'/g)].map((m) => m[1] ?? '')),
    ]
      .filter((k) => k !== 'review_mode')
      .sort();
    expect(serverKeys.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(RECONCILE_CLASS_LABELS).sort()).toEqual(serverKeys);
  });
});

describe('运营日志：对象可点（走查 2026-10-08）', () => {
  it('🔴 订单类操作的对象 → 订单详情链接；客户 / 拉黑类 → 客户详情；其它（商品、Banner）不给链接', () => {
    const rows = auditRows([
      {
        id: 1,
        action: 'POST /admin/orders/:id/partial-refunds',
        target: 'ord-8645ff12',
        created_at: '2026-10-09T04:57:00.000Z',
      },
      {
        id: 2,
        action: 'POST /admin/users/:id/block',
        target: 'u-307ae3f3',
        created_at: '2026-10-09T04:57:00.000Z',
      },
      {
        id: 3,
        action: 'DELETE /admin/customers/:id/events',
        target: 'u-307ae3f3',
        created_at: '2026-10-09T04:57:00.000Z',
      },
      {
        id: 4,
        action: 'PATCH /admin/products/:id/status',
        target: '345e9f9e',
        created_at: '2026-10-09T04:57:00.000Z',
      },
      { id: 5, action: 'POST /admin/orders/:id/ship', created_at: '2026-10-09T04:57:00.000Z' },
    ]);
    expect(rows.map((r) => r.targetHref)).toEqual([
      '#/orders/ord-8645ff12',
      '#/customers/u-307ae3f3',
      '#/customers/u-307ae3f3',
      '',
      '',
    ]);
  });

  describe('ADM-8（AJ-470）：三类此前显示英文的操作有中文名；新端点也登记', () => {
    it.each([
      ['POST /admin/orders/:id/notes', '添加备注'],
      ['POST /admin/orders/ship-batch', '批量发货'],
      ['DELETE /admin/customers/:id/events', '删除客户行为记录'],
      ['POST /admin/orders/:id/shipment/revert', '撤销发货'],
      ['CLI admin.revoke', '命令行撤销管理员'],
    ])('%s → %s', (action, label) => {
      expect(ACTION_LABELS[action]).toBe(label);
    });
  });
});
