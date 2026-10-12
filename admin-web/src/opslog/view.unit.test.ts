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
      statusText: '出错', // 原断言 '500'：把裸状态码锁成了对的（全入口点击测试 2026-10-12）
      statusTitle: 'HTTP 500',
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

  // 全入口点击测试 2026-10-12：结果列写 200 / 201 / 202；对象列写 purchase、health、img/…、batch:1/1、编辑分类却是"—"
  it('🔴 结果列说人话：2xx 成功、202 已提交（结果见订单详情）、4xx 被拒绝、5xx 出错；状态码留在悬停里', () => {
    const at = (status_code: number) =>
      auditRows([{ id: 1, actor: 'a', action: 'x', status_code, created_at: '' }])[0];
    expect(at(200)).toMatchObject({ statusText: '成功', statusTitle: 'HTTP 200', failed: false });
    expect(at(201)?.statusText).toBe('成功');
    expect(at(202)?.statusText).toBe('已提交（结果见订单详情）');
    expect(at(409)).toMatchObject({ statusText: '被拒绝', failed: true });
    expect(at(502)).toMatchObject({ statusText: '出错', failed: true });
  });

  it('🔴 对象列说人话：导出写表名、分类写分类名、上传写"图片"、批量发货写"成功 N / 共 M 单"', () => {
    const row = (action: string, target: string) =>
      auditRows([{ id: 1, actor: 'a', action, target, status_code: 200, created_at: '' }], {
        categoryNames: { health: '健康食品' },
      })[0]?.targetText;
    expect(row('GET /admin/exports/:kind', 'purchase')).toBe('待采购清单');
    expect(row('GET /admin/exports/:kind', 'orders')).toBe('订单总表');
    expect(row('GET /admin/exports/:kind', 'customs')).toBe('报关表');
    expect(row('POST /admin/categories', 'health')).toBe('健康食品');
    expect(row('PUT /admin/categories/:key', 'gone_key')).toBe('gone_key'); // 已删的分类：原样给键
    expect(row('POST /admin/upload', 'img/f566a40c-560a-4b1e-9c1a-0e7f1d2c3b4a')).toBe('图片');
    expect(row('POST /admin/orders/ship-batch', 'batch:3/4')).toBe('成功 3 / 共 4 单');
  });

  it('🔴 服务端给了 target_label（订单号 / 商品名，AJ-499）→ 对象列写它，链接与悬停仍用内部 id', () => {
    const [o, p] = auditRows([
      {
        id: 1,
        actor: 'a',
        action: 'POST /admin/orders/:id/ship',
        target: 'ord-0f3508cf-69ac-4599-a99d-62ae4cdf8058',
        target_label: '261012-EPT8V3',
        status_code: 200,
        created_at: '',
      },
      {
        id: 2,
        actor: 'a',
        action: 'PUT /admin/products/:id',
        target: '7f3c2a10-4b5e-4c6d-8e9f-0a1b2c3d4e5f',
        target_label: '南部铁器 铁壶 0.6L',
        status_code: 200,
        created_at: '',
      },
    ]);
    expect(o).toMatchObject({
      targetText: '261012-EPT8V3',
      targetHref: '#/orders/ord-0f3508cf-69ac-4599-a99d-62ae4cdf8058',
      targetTitle: 'ord-0f3508cf-69ac-4599-a99d-62ae4cdf8058',
    });
    expect(p?.targetText).toBe('南部铁器 铁壶 0.6L');
  });

  it('🔴 命令行操作的操作人写"命令行（服务器上执行）"，不写 cli:admin-password', () => {
    const [r] = auditRows([
      { id: 1, actor: 'cli:admin-password', action: 'CLI admin.password.reset', created_at: '' },
    ]);
    expect(r?.actor).toBe('命令行（服务器上执行）');
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
      // 规律排查 2026-10-12：只写时刻不写时区，在中国的同事读差一小时
      headline: '最近一次自动核对 2026-10-06 03:00（日本时间）：无异常',
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

  // 规律排查 2026-10-12：卡住的全额退款说"到订单详情点「同步」"——「同步」只在部分退款行上有
  it('🔴 卡住的全额退款指向「全额退款…」→「重新提交退款」', () => {
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: { stuck_refunds: 2 },
      samples: {},
    });
    expect(v.rows[0]?.advice).toContain('「重新提交退款」');
    expect(v.rows[0]?.advice).not.toContain('「同步」');
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

  // 两端逐页走查 2026-10-12：示例写的是 ord-70d4257d… / pay-6cfc82a4…——运营在后台找不到这些编号
  it('🔴 服务端给了 sample_orders → 示例显示订单号、链到订单详情（含 pay- 取样）', () => {
    const oid = 'ord-70d4257d-ddc6-4818-802b-a435108392cf';
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: { late_paid_unrefunded: 1, dangling_initiated_payments: 1 },
      samples: {
        late_paid_unrefunded: [oid],
        dangling_initiated_payments: ['pay-6cfc82a4-3ced-4b19-a89a-9b830e179960'],
      },
      sample_orders: {
        [oid]: { order_id: oid, order_no: '261009-F2Z45G' },
        'pay-6cfc82a4-3ced-4b19-a89a-9b830e179960': { order_id: oid, order_no: '261009-F2Z45G' },
      },
    });
    expect(v.rows.flatMap((r) => r.samples)).toEqual([
      { label: '261009-F2Z45G', href: `#/orders/${oid}` },
      { label: '261009-F2Z45G', href: `#/orders/${oid}` },
    ]);
  });

  // AJ-505 的取样是整句说明：原先被截成 16 个字加"…"、用等宽字体，且只列 3 条
  it('🔴 整句说明的取样原文显示、不截短（plain），这一类全部列出', () => {
    const texts = [
      '运费表没有启用中的档位（买家报价一律"运费不可计算"）',
      '缺少 CNY 汇率（商品不显示 CNY 折算价）',
      '缺少 USD 汇率（商品不显示 USD 折算价，银行卡按美元收款无法发起）',
      '审核商品 p-review 不存在（审核期只有它能下单）',
    ];
    const v = reconciliationView({
      ran_at: '2026-10-05T18:00:00.000Z',
      counts: { launch_not_ready: 4 },
      samples: { launch_not_ready: texts },
    });
    expect(v.rows[0]?.samples).toEqual(texts.map((t) => ({ label: t, href: '', plain: true })));
    expect(v.rows[0]?.more).toBe(0);
    // 三天提交复查 2026-10-12：AJ-509 给这一类加了"没有配置邮件服务"——运营在页面上配不了，建议里要说转技术人员
    expect(v.rows[0]?.advice).toContain('邮件服务');
    expect(v.rows[0]?.advice).toContain('技术人员');
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
