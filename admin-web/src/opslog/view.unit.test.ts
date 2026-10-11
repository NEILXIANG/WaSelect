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

describe('reconciliationView', () => {
  // AJ-410：「对账」改白话「自动核对」
  it('没跑过 → 明确说"还没有自动核对记录"', () => {
    expect(reconciliationView(null)).toEqual({
      headline: '还没有自动核对记录',
      ok: false,
      lines: [],
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
      lines: [],
    });
  });

  it('🔴 有异常 → 只列非零类，中文类名 + 计数 + 取样 id；不认识的类名原样显示', () => {
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: { stuck_refunds: 2, dangling_initiated_payments: 0, brand_new_class: 1 },
      samples: { stuck_refunds: ['o-1', 'o-2'], brand_new_class: ['x'] },
    });
    expect(v.ok).toBe(false);
    expect(v.headline).toContain('2 类异常');
    expect(v.lines).toEqual([
      {
        text: `${RECONCILE_CLASS_LABELS['stuck_refunds'] ?? ''}：2`,
        samples: [
          { label: 'o-1', href: '' },
          { label: 'o-2', href: '' },
        ],
      },
      { text: 'brand_new_class：1', samples: [{ label: 'x', href: '' }] },
    ]);
  });

  // 三端模拟测试 2026-10-11：取样是 `ord-<uuid>` 或 `order.paid:ord-<uuid>`，原样拼成一长串、点不了，
  // 运营认不出也打不开是哪张单（71 条通知放弃 → 20 个 36 位 id 连成一段）
  it('🔴 取样里认出订单 id → 链到订单详情，显示缩短的 id；带前缀的通知键也认', () => {
    const id = 'ord-09236ad4-ddc6-4818-802b-a435108392cf';
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: { stuck_refunds: 1, notification_dead: 1 },
      samples: { stuck_refunds: [id], notification_dead: [`order.paid:${id}`] },
    });
    expect(v.lines.map((l) => l.samples)).toEqual([
      [{ label: 'ord-09236ad4…', href: `#/orders/${id}` }],
      [{ label: 'ord-09236ad4…', href: `#/orders/${id}` }],
    ]);
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
