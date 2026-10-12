/**
 * 职责：**业务旅程**——一单从运营上架走到售后结案，每一步把**真服务端**（生产装配 + 真库）的响应
 *      喂给小程序页面的 view-model 与后台的 view 函数，断言**买家 / 运营在那一步看到的那句话**。
 *
 * @why 测试缺口复盘（docs/测试缺口复盘-2026-10-12.md）：两天里真实界面上找到的问题，旧测试一个都没拦住。
 *      根因之一是**没有"一件事做到底"的测试形态**——单测证明每一块各自对，接缝测试只走主路径的一段；
 *      根因之二是**数据不像真的**（接缝 fixture 叫 Chef Knife / Jane Doe）。本文件补这两样：
 *      ① 一条完整业务链：上架 → 买家浏览 → 加购超出库存（自动改到可买件数）→ 下单（不留邮箱）→ 付款
 *         → 运营看到待发货、时间线、通道名 → 发货（没邮箱的提示）→ 买家看物流 → 确认收货 → 申请售后
 *         → 运营部分退款并结案 → 买家看到处理结果 → 导出订单总表；
 *      ② 像真的数据：中文标题 + 日文原名、美国华人收件人、加州地址、没留邮箱的买家。
 * @why 每一步都过一遍"看得懂"不变量（test/helpers/readable.ts）：不管文案怎么写，展示文字里出现内部 id、
 *      英文状态、通道代号、裸错误码、「円」就是缺陷——这是**独立于实现**的判据（旧测试照实现抄期望值，
 *      17 / 46 个修复要改旧断言，即缺陷曾被断言锁住）。
 * @why 期望文案是**按读者核过之后**写下的（先跑探针看每一步输出、逐句判断"运营 / 买家看得懂吗、说得对吗"），
 *      不是从输出里直接抄。
 *
 * @limitation 一：WXML 绑定、React 组件渲染、布局都不在这里（约束十一；jsdom 无布局）——布局仍靠全入口点击清单。
 * @limitation 二：支付是 mock 通道 + 手工签名回调（同 chain-server 的边界），Stripe 页面不在这里。
 * @limitation 三：用例按顺序共享一张单（旅程本来就是有序的）；前一步红了后一步会跟着红，读第一条红灯即可。
 *
 * @see test/helpers/chain-server.ts；test/helpers/readable.ts；docs/测试缺口复盘-2026-10-12.md
 */
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import {
  buildChainServer,
  call,
  CHAIN_TERMS,
  mockCallback,
  seedChainFixture,
  tokenFor,
  type ChainServer,
} from '../helpers/chain-server.js';
import { unreadable } from '../helpers/readable.js';
import { createAdminApi } from '../../admin-web/src/api/client.js';
import { createProduct, listProducts, setProductStatus } from '../../admin-web/src/products/api.js';
import {
  emptyProductForm,
  productRows,
  toProductInput,
} from '../../admin-web/src/products/view.js';
import {
  createPartialRefund,
  getOrder,
  listOrders,
  resolveAfterSale,
  shipOrder,
} from '../../admin-web/src/orders/api.js';
import {
  eventActorText,
  eventNoteView,
  eventStatusText,
  orderRows as adminOrderRows,
  paymentSummary,
} from '../../admin-web/src/orders/view.js';
import { shipMailNotes } from '../../admin-web/src/orders/fix-view.js';
import { afterSaleRows } from '../../admin-web/src/orders/after-sale-view.js';
import { channelLabelsFrom } from '../../admin-web/src/orders/channel-labels.js';
import { productCards } from '../../miniprogram/pages/home/index.vm.js';
import { detailView as productDetailView } from '../../miniprogram/pages/detail/index.vm.js';
import { cartRows, stockAdjust } from '../../miniprogram/pages/cart/index.vm.js';
import { orderRows as buyerOrderRows } from '../../miniprogram/pages/order/index.vm.js';
import { detailView as orderDetailView } from '../../miniprogram/pages/order-detail/index.vm.js';
import {
  initialForm,
  REASON_LABELS,
  submitBody,
} from '../../miniprogram/pages/after-sale/index.vm.js';

let db: Db;
let srv: ChainServer;
let buyer = '';
let adminToken = '';

const admin = () =>
  createAdminApi({ baseUrl: srv.url, getToken: () => adminToken, onUnauthorized: () => undefined });

/** 旅程里共享的那张单与那件商品。 */
const J = { productId: '', orderId: '', orderNo: '', afterSaleId: '' };

/**
 * 走查用：`JOURNEY_DUMP=<文件> npx vitest run --project e2e test/e2e/business-journey.e2e.test.ts`
 * 把每一步买家 / 运营看到的东西写进文件，供改文案后逐句重读（本文件的期望值就是这样读过之后才定的）。
 * 不设该变量时什么都不做（vitest 配置屏蔽了 console，所以写文件）。
 */
const show = (label: string, v: unknown): void => {
  const f = process.env['JOURNEY_DUMP'];
  if (f) appendFileSync(f, `\n=== ${label}\n${JSON.stringify(v, null, 1)}\n`);
};

/** 每一步都过"看得懂"不变量；红了时把哪一处、为什么一起打出来。 */
const expectReadable = (v: unknown): void => {
  expect(unreadable(v)).toEqual([]);
};

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  srv = await buildChainServer(db);
  await resetTestDb(db);
  await seedChainFixture(db);
  // 像真的买家：美国华人（收件人须是英文字母——面单给美国承运商看，迁移 001 的 CHECK），加州地址，不留邮箱
  await db`insert into users (id, openid, email, is_admin) values ('u-chen', 'o-chen', null, false)`;
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, line2, city, state, postal_code, country, is_default)
    values ('addr-chen', 'u-chen', 'Jing Chen', '+14155550188', '1288 Stockton St', 'Apt 3B',
            'San Francisco', 'CA', '94133', 'US', true)`;
  buyer = await tokenFor('u-chen');
  adminToken = await tokenFor('u-admin', 'admin');
}, 30_000);

afterAll(async () => {
  await srv.close();
  await db.end();
});

describe('一单的一生：运营上架 → 买家下单付款 → 运营发货 → 买家收货申请售后 → 运营退款结案', () => {
  it('① 运营新建商品（中文名 + 日文原名）→ 草稿 → 上架；列表行看得懂', async () => {
    const form = {
      ...emptyProductForm(),
      title: '南部铁器 岩铸 铁壶 0.6L 雾面黑',
      titleJa: '南部鉄器 岩鋳 鉄瓶 0.6L',
      category: 'kitchen',
      priceJpy: '16500',
      weightG: '1350',
      stock: '2',
      customsDescEn: 'cast iron kettle',
      hsCode: '7323.91',
      janCode: '4970135123456',
      purchaseSource: '岩鋳 盛岡本店',
    };
    const created = await createProduct(admin(), toProductInput(form));
    J.productId = created.id;
    await setProductStatus(admin(), created.id, 'active');
    const rows = productRows((await listProducts(admin())).items).filter(
      (r) => r.id === J.productId,
    );
    show('后台商品列表行', rows);
    expectReadable(rows);
    expect(rows[0]).toMatchObject({
      title: '南部铁器 岩铸 铁壶 0.6L 雾面黑',
      priceText: '16,500 日元',
      statusText: '在售',
      stockText: '2',
      lowStock: true, // 只剩 2 件：列表上要标出来
    });
  });

  it('② 买家逛首页、看详情；加购 3 件（库存只有 2）→ 报价 40901 → 购物车自动改到 2 件并说明', async () => {
    const list = await call(srv, 'GET', '/api/v1/products?size=50');
    const card = productCards(list.json['items']).find((c) => c.id === J.productId);
    show('小程序首页卡片', card);
    expectReadable(card);
    expect(card?.title).toBe('南部铁器 岩铸 铁壶 0.6L 雾面黑');
    expect(card?.priceJpy).toBe(16500);
    expect(card?.subPrice).toMatch(/^≈ \$\d+\.\d{2} · ≈ 人民币 ¥[\d,]+\.\d{2}$/);
    const detail = productDetailView(
      (await call(srv, 'GET', `/api/v1/products/${J.productId}`)).json,
    );
    show('小程序商品详情', detail);
    expectReadable(detail);
    expect(detail.lowStockText).toBe('仅剩 2 件');
    expect(detail.specs).toContainEqual({ label: '重量', value: '约 1350 g' });

    const rows = cartRows([
      { productId: J.productId, title: card?.title, priceJpy: card?.priceJpy, qty: 3 },
    ]);
    const q = await call(srv, 'POST', '/api/v1/orders/quote', {
      token: buyer,
      body: { items: [{ product_id: J.productId, qty: 3 }], address_id: 'addr-chen' },
    });
    show('报价（超库存）', { status: q.status, json: q.json });
    const adj = stockAdjust(rows, q.json);
    show('购物车自动调整', adj);
    expectReadable({ rows, adj });
    expect(q.json['code']).toBe(40901);
    // 不是只报"库存不足"让买家自己猜改几件：直接改到能买的件数并说明（AJ-493）
    expect(adj).toEqual({ productId: J.productId, qty: 2, text: '库存只剩 2 件，已改为 2 件' });
  });

  it('③ 买家下单 2 件（不留邮箱）→ 付款；订单列表 / 详情看得懂，时间线只有"提交订单 / 付款成功"', async () => {
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-journey',
      body: {
        items: [{ product_id: J.productId, qty: 2 }],
        address_id: 'addr-chen',
        terms_version: CHAIN_TERMS,
      },
    });
    show('建单', { status: c.status, json: c.json });
    J.orderId = String(c.json['order_id']);
    J.orderNo = String(c.json['order_no']);
    await call(srv, 'POST', `/api/v1/orders/${J.orderId}/pay`, {
      token: buyer,
      key: 'pay-journey',
      body: { channel: 'mock' },
    });
    expect((await mockCallback(srv, db, J.orderId, { eventId: 'evt-journey' })).status).toBe(200);
    const rows = buyerOrderRows(
      (await call(srv, 'GET', '/api/v1/orders', { token: buyer })).json['items'],
    );
    const d = orderDetailView(
      (await call(srv, 'GET', `/api/v1/orders/${J.orderId}`, { token: buyer })).json,
      { nowMs: Date.now() },
    );
    show('小程序订单列表行', rows);
    show('小程序订单详情', d);
    expectReadable({ rows, d });
    expect(rows[0]).toMatchObject({
      orderNo: J.orderNo,
      statusText: '已付款 · 日本采购中',
      totalText: '39,600 日元',
      itemCountText: '共 2 件',
      titleText: '南部铁器 岩铸 铁壶 0.6L 雾面黑',
    });
    expect(d.statusText).toBe(rows[0]?.statusText); // 列表与详情同一说法
    expect(d.amountLines.map((l) => [l.label, l.value])).toEqual([
      ['商品合计', '33,000 日元'], // 16,500 × 2
      ['运费', '6,600 日元'],
    ]);
    expect(d.dutyNote).toBe('其中预估关税 4,950 日元（已含在商品价内）');
    // 付款后时间线只讲发生过的事：没有"付款中"（与付款成功相隔一秒，对买家没有信息，2026-10-11 修过）
    expect(d.timeline.map((t) => t.statusText)).toEqual(['提交订单', '付款成功']);
    // 美国写法「城市, 州 邮编」；电话按美国习惯分段（复盘 2026-10-12：原为 "San Francisco, CA, 94133"）
    expect(d.address).toMatchObject({
      recipient: 'Jing Chen',
      phone: '+1 (415) 555-0188',
      region: 'San Francisco, CA 94133',
    });
    expect(d.canPay).toBe(false);
  });

  it('④ 运营：订单列表行、详情时间线（谁做的、通道中文名）、支付摘要；没邮箱时发货提示不说"已发邮件"', async () => {
    const settings = (await call(srv, 'GET', '/api/v1/admin/settings', { token: adminToken })).json;
    const labels = channelLabelsFrom(settings as never);
    const rows = adminOrderRows((await listOrders(admin())).items).filter(
      (r) => r.id === J.orderId,
    );
    const order = await getOrder(admin(), J.orderId);
    const events = (
      ((order as unknown as Record<string, unknown>)['events'] as unknown[]) ?? []
    ).map((e) => {
      const ev = e as Record<string, unknown>;
      return {
        what: eventStatusText(ev['status']),
        who: eventActorText(ev, labels),
        note: eventNoteView(ev['status'], ev['note']).text,
      };
    });
    const pay = paymentSummary(order, labels);
    const mail = shipMailNotes(order);
    show('后台订单列表行', rows);
    show('后台时间线', events);
    show('后台支付摘要', pay);
    show('后台发货提示', mail);
    expectReadable({ rows, events, pay, mail });
    expect(rows[0]).toMatchObject({
      statusText: '待发货',
      totalText: '39,600 日元',
      recipientText: 'Jing Chen',
    });
    // 采购员照这一行去买：日文原名 + JAN + 来源
    expect(rows[0]?.purchaseLines[0]).toBe(
      '日文原名：南部鉄器 岩鋳 鉄瓶 0.6L · JAN：4970135123456 · 采购来源：岩鋳 盛岡本店',
    );
    expect(events.map((e) => `${e.what} · ${e.who}`)).toEqual([
      '下单（等待买家付款） · 买家',
      '发起付款 · 买家', // 不是"买家发起付款 · 买家"（复盘 2026-10-12）
      '付款成功（待发货） · 支付机构 模拟支付', // 不是"待发货 · 支付机构 mock"（2026-10-11 修过）
    ]);
    expect(pay).toBe('模拟支付 · 39,600 日元');
    // 买家没留邮箱：不能说"邮件已发给买家"（2026-10-11 修过）
    expect(mail.confirm).toBe('买家没留邮箱，不会收到发货邮件。');
  });

  it('⑤ 运营发货 → 买家看到已发货、物流卡、查件；确认收货', async () => {
    await shipOrder(admin(), J.orderId, {
      carrier: 'Japan Post EMS',
      tracking_no: 'EJ123456789JP',
    });
    const d = orderDetailView(
      (await call(srv, 'GET', `/api/v1/orders/${J.orderId}`, { token: buyer })).json,
      { nowMs: Date.now() },
    );
    show('小程序订单详情（已发货）', d);
    expectReadable(d);
    expect(d.statusText).toBe('已发货 · 国际运输中');
    expect(d).toMatchObject({
      carrier: 'Japan Post EMS',
      trackingNo: 'EJ123456789JP',
      hasTracking: true,
      canConfirmReceipt: true,
    });
    expect(d.trackingUrl).toContain('EJ123456789JP'); // 日本邮政官网查件页
    expect(d.addressChangeHint).toBe(''); // 发货后不再提示"可联系客服改地址"
    const r = await call(srv, 'POST', `/api/v1/orders/${J.orderId}/confirm-receipt`, {
      token: buyer,
      key: 'cr-journey',
      body: {},
    });
    show('确认收货', { status: r.status, json: r.json });
    const d2 = orderDetailView(
      (await call(srv, 'GET', `/api/v1/orders/${J.orderId}`, { token: buyer })).json,
      { nowMs: Date.now() },
    );
    show('小程序订单详情（已收货）', d2);
    expectReadable(d2);
    expect(r.status).toBe(200);
    expect(d2.statusText).toBe('已送达');
    expect(d2.canConfirmReceipt).toBe(false);
    expect(d2.afterSale).toMatchObject({ show: true, canApply: true });
    expect(d2.timeline.map((t) => t.statusText)).toEqual([
      '提交订单',
      '付款成功',
      '已发货',
      '已送达',
    ]);
  });

  it('⑥ 买家申请售后（壶身有裂纹）→ 运营看到申请 → 部分退款 5,000 日元 → 结案；买家看到结果', async () => {
    const form = {
      ...initialForm(),
      reasonIndex: REASON_LABELS.indexOf('商品破损'),
      description: '收到后发现壶身侧面有一道裂纹，倒水会渗',
    };
    show('售后原因选项', REASON_LABELS);
    const b = submitBody(form);
    expect(b.ok).toBe(true);
    const s = await call(srv, 'POST', `/api/v1/orders/${J.orderId}/after-sales`, {
      token: buyer,
      key: 'as-journey',
      body: b.ok ? b.body : {},
    });
    show('提交售后', { status: s.status, json: s.json });
    const order = await getOrder(admin(), J.orderId);
    const asRows = afterSaleRows(order);
    show('后台售后行', asRows);
    expectReadable(asRows);
    expect(s.status).toBe(201);
    expect(asRows[0]).toMatchObject({
      reasonText: '商品破损',
      statusText: '已提交，等待处理',
      description: '收到后发现壶身侧面有一道裂纹，倒水会渗',
    });
    J.afterSaleId = String(asRows[0]?.id ?? '');
    const refund = await createPartialRefund(admin(), J.orderId, {
      amount_minor: 5000,
      reason: '壶身裂纹，协商部分退款',
    });
    show('部分退款', refund);
    await resolveAfterSale(admin(), J.orderId, J.afterSaleId, {
      status: 'resolved',
      note: '已部分退款 5,000 日元，3–5 个工作日原路到账',
    });
    const d = orderDetailView(
      (await call(srv, 'GET', `/api/v1/orders/${J.orderId}`, { token: buyer })).json,
      { nowMs: Date.now() },
    );
    show('小程序订单详情（售后结案）', d);
    expectReadable(d);
    expect((refund as { status?: unknown } | null)?.status).toBe('succeeded');
    expect(d.partialRefunds).toEqual([
      expect.objectContaining({ amountText: '5,000 日元', statusText: '已退回' }),
    ]);
    expect(d.afterSale.current).toMatchObject({
      reasonText: '商品破损',
      statusText: '已处理',
      note: '已部分退款 5,000 日元，3–5 个工作日原路到账',
      open: false,
    });
    expect(d.nextText).toBe('售后已有处理结果（见下方）；还有问题可以再次申请。');
    const after = await getOrder(admin(), J.orderId);
    const settings = (await call(srv, 'GET', '/api/v1/admin/settings', { token: adminToken })).json;
    const labels = channelLabelsFrom(settings as never);
    const events = (
      ((after as unknown as Record<string, unknown>)['events'] as unknown[]) ?? []
    ).map((e) => {
      const ev = e as Record<string, unknown>;
      return {
        what: eventStatusText(ev['status']),
        who: eventActorText(ev, labels),
        note: eventNoteView(ev['status'], ev['note']).text,
      };
    });
    show('后台时间线（结案后）', events);
    show('后台售后行（结案后）', afterSaleRows(after));
    expectReadable({ events, rows: afterSaleRows(after) });
    // 运营回看这一单：每一步谁做的、做了什么，一眼读得出
    expect(events.slice(3).map((e) => [e.what, e.who, e.note])).toEqual([
      ['已发货', 'admin@example.com', 'Japan Post EMS / EJ123456789JP'],
      ['已签收', '买家', '买家确认收货'],
      ['部分退款成功', 'admin@example.com', '5,000 日元'],
      ['处理售后', 'admin@example.com', '已处理：已部分退款 5,000 日元，3–5 个工作日原路到账'],
    ]);
    expect(afterSaleRows(after)[0]).toMatchObject({ statusText: '已处理', open: false });
  });

  it('⑦ 运营导出订单总表：表头中文、金额写日元、状态中文', async () => {
    const r = await call(srv, 'GET', '/api/v1/admin/exports/orders', { token: adminToken });
    const csv = String(r.json['csv'] ?? '');
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    show('订单总表 CSV', lines.slice(0, 3));
    expect(lines[0]).toBe(
      '订单号,状态,下单时间（日本时间）,付款时间（日本时间）,发货时间（日本时间）,商品金额（日元）,运费（日元）,预估关税（日元）,订单合计（日元）,收件人,州,国家,承运商,运单号,实付币种,实付金额',
    );
    const row = lines.find((l) => l.startsWith(J.orderNo)) ?? '';
    expect(row.split(',').slice(1, 2)).toEqual(['已签收']);
    expect(row).toContain(
      ',33000,6600,4950,39600,Jing Chen,CA,US,Japan Post EMS,EJ123456789JP,JPY,39600',
    );
    expectReadable(lines);
  });
});
