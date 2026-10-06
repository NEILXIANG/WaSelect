/** 职责：运营日志页的纯函数（剩余清单 3-2）。 */
import { describe, expect, it } from 'vitest';
import { RECONCILE_CLASS_LABELS, auditRows, reconciliationView } from './view.js';

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

describe('reconciliationView', () => {
  it('没跑过 → 明确说"还没有对账记录"', () => {
    expect(reconciliationView(null)).toEqual({ headline: '还没有对账记录', ok: false, lines: [] });
  });

  it('零异常 → ok，标题带 JST 时间', () => {
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: { stuck_refunds: 0 },
      samples: {},
    });
    expect(v).toEqual({ headline: '最近一次对账 2026-10-06 03:00：无异常', ok: true, lines: [] });
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
      `${RECONCILE_CLASS_LABELS['stuck_refunds'] ?? ''}：2（o-1、o-2）`,
      'brand_new_class：1（x）',
    ]);
  });

  it('六类异常都配了中文名（服务端 daily-reconciliation.ts 的 key）', () => {
    expect(Object.keys(RECONCILE_CLASS_LABELS).sort()).toEqual([
      'callback_anomalies_48h',
      'dangling_initiated_payments',
      'paid_without_succeeded_payment',
      'stalled_heartbeats',
      'stuck_refunds',
      'unfinished_callbacks',
    ]);
  });
});
