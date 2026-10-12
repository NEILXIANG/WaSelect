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
  runExpireJob,
  seedChainFixture,
  tokenFor,
  type ChainServer,
} from '../helpers/chain-server.js';
import { unreadable } from '../helpers/readable.js';
import { markDisputeClosed } from '../../server/src/app/mark-disputed.js';
import { listDisputes } from '../../admin-web/src/risk/api.js';
import { blockDoneText, disputeRows } from '../../admin-web/src/risk/view.js';
import { addressRejectText } from '@waselect/shared';
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
  refundOrder,
  resolveAfterSale,
  shipOrder,
  updateOrderAddress,
} from '../../admin-web/src/orders/api.js';
import {
  addressFormErrors,
  addressFormModel,
  toAddressInput,
} from '../../admin-web/src/orders/address-view.js';
import {
  fullRefundAmountText,
  fullRefundConfirmBody,
} from '../../admin-web/src/orders/partial-refund-view.js';
import { orderShortcuts } from '../../miniprogram/pages/user/index.vm.js';
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
import { cartRows, markInvalid, stockAdjust } from '../../miniprogram/pages/cart/index.vm.js';
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
/** 买家 id 用真实形状（u- + 36 位）：短 id（如 u-chen）漏进文案时「看得懂」判据认不出（2026-10-12 拉黑提示就这样漏过一次） */
const BUYER_ID = 'u-3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f60718';
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
  await db`insert into users (id, openid, email, is_admin) values (${BUYER_ID}, 'o-chen', null, false)`;
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, line2, city, state, postal_code, country, is_default)
    values ('addr-chen', ${BUYER_ID}, 'Jing Chen', '+14155550188', '1288 Stockton St', 'Apt 3B',
            'San Francisco', 'CA', '94133', 'US', true)`;
  buyer = await tokenFor(BUYER_ID);
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

/** 第二条旅程的共享状态：一件只有 3 件库存的商品，三张单分别走"退款 / 超时 / 取消"。 */
const K = { productId: 'p-matcha', refundOrder: '', expireOrder: '', cancelOrder: '' };

const stockOf = async (): Promise<number> => {
  const [r] = await db`select stock from products where id = ${K.productId}`;
  return Number(r?.['stock']);
};

const buyerDetail = async (id: string) =>
  orderDetailView((await call(srv, 'GET', `/api/v1/orders/${id}`, { token: buyer })).json, {
    nowMs: Date.now(),
  });

const placeOrder = async (key: string, qty: number): Promise<string> => {
  const c = await call(srv, 'POST', '/api/v1/orders', {
    token: buyer,
    key,
    body: {
      items: [{ product_id: K.productId, qty }],
      address_id: 'addr-chen',
      terms_version: CHAIN_TERMS,
      contact_email: 'jing.chen@gmail.com',
    },
  });
  expect(c.status).toBe(201);
  return String(c.json['order_id']);
};

describe('钱走回头路与没付成：未发货全额退款、超时关单、买家取消——库存都要回来，两端说法一致', () => {
  beforeAll(async () => {
    await db`
      insert into products (id, title, title_ja, category, price_jpy, weight_g, stock, origin_country, status,
                            customs_desc_en, hs_code)
      values (${K.productId}, '丸久小山园 抹茶 又玄 40g', '丸久小山園 抹茶 又玄 40g', 'food', 3240, 120, 3, 'JP',
              'active', 'matcha green tea powder', '0902.10')`;
  });

  it('⑧ 付款后未发货 → 运营全额退款 → 买家看到退款、运营列表状态变、库存回来', async () => {
    K.refundOrder = await placeOrder('k-refund', 2);
    expect(await stockOf()).toBe(1); // 下单即占库存
    await call(srv, 'POST', `/api/v1/orders/${K.refundOrder}/pay`, {
      token: buyer,
      key: 'pay-refund',
      body: { channel: 'mock' },
    });
    expect((await mockCallback(srv, db, K.refundOrder, { eventId: 'evt-refund' })).status).toBe(
      200,
    );
    const order = await getOrder(admin(), K.refundOrder);
    show('全额退款前：后台闸门与确认文案', {
      gate: adminOrderRows([order])[0]?.actions.refund,
      confirm: fullRefundConfirmBody(order),
      amount: fullRefundAmountText(order),
    });
    // 确认框写的是要退的钱数，不只是"确定退款吗"（AJ-439）
    expect(fullRefundConfirmBody(order)).toMatch(
      /^订单 \d{6}-[0-9A-Z]{6}：将原路退回 8,630 日元。退款原因会记录下来。$/,
    );
    const outcome = await refundOrder(admin(), K.refundOrder, { reason: '买家付款后说买错了规格' });
    show('全额退款结果', outcome);
    expect(outcome).toBe('succeeded');
    const d = await buyerDetail(K.refundOrder);
    show('小程序详情（已退款）', d);
    const rows = adminOrderRows((await listOrders(admin())).items).filter(
      (r) => r.id === K.refundOrder,
    );
    show('后台列表行（已退款）', rows);
    show('库存', await stockOf());
    expectReadable({ d, rows });
    expect(await stockOf()).toBe(3); // 未发货退款：占的 2 件回到库存
    expect(d.statusText).toBe('已退款');
    expect(d.nextText).toBe(
      '款项已原路退回到你的付款方式，到账通常需要 5–10 个工作日，以银行为准。',
    );
    expect(d.timeline.map((t) => t.statusText)).toEqual([
      '提交订单',
      '付款成功',
      '开始退款',
      '退款完成',
    ]);
    expect(rows[0]?.statusText).toBe('已退款');
    expect(rows[0]?.actions.ship).toEqual({ ok: false, reason: '已退款，不能发货' });
    // 不提"联系承运商"：这单没发货（复盘 2026-10-12）
    expect(rows[0]?.actions.address.reason).toBe('仅"待发货"可改址（当前：已退款）');
  });

  it('⑨ 下单不付 → 到点关单 → 买家看到已关闭、可再次购买；库存回来', async () => {
    K.expireOrder = await placeOrder('k-expire', 1);
    const before = await buyerDetail(K.expireOrder);
    show('小程序详情（待付款）', before);
    await runExpireJob(db, srv, new Date(Date.now() + 2 * 60 * 60 * 1000));
    const d = await buyerDetail(K.expireOrder);
    show('小程序详情（超时关闭）', d);
    const rows = adminOrderRows((await listOrders(admin())).items).filter(
      (r) => r.id === K.expireOrder,
    );
    show('后台列表行（超时关闭）', rows);
    show('库存', await stockOf());
    expectReadable({ before, d, rows });
    expect(before).toMatchObject({ statusText: '待付款', canPay: true, canCancel: true });
    expect(before.payLeftText).toMatch(/^请在 \d+ 分钟内完成支付$/); // 买家在美国：给剩余分钟，不只给日本时间截止时刻
    expect(d).toMatchObject({ statusText: '已超时关闭', canPay: false, canBuyAgain: true });
    expect(d.nextText).toBe('超过支付时间，订单已自动关闭；需要的话可以重新下单。');
    expect(d.timeline.map((t) => t.statusText)).toEqual(['提交订单', '超时未付款，订单关闭']);
    // 后台与买家同一件事同一说法（原写「已过期」，复盘 2026-10-12）
    expect(rows[0]?.statusText).toBe('超时关闭');
    expect(await stockOf()).toBe(3);
  });

  it('⑩ 买家下单后主动取消 → 已取消；库存回来；「我的」角标不再计待付款', async () => {
    K.cancelOrder = await placeOrder('k-cancel', 1);
    const counts1 = (await call(srv, 'GET', '/api/v1/orders/counts', { token: buyer })).json;
    show('我的·角标（取消前）', orderShortcuts(counts1));
    const r = await call(srv, 'POST', `/api/v1/orders/${K.cancelOrder}/cancel`, {
      token: buyer,
      key: 'cancel-1',
      body: {},
    });
    show('取消', { status: r.status, json: r.json });
    const d = await buyerDetail(K.cancelOrder);
    show('小程序详情（已取消）', d);
    const counts2 = (await call(srv, 'GET', '/api/v1/orders/counts', { token: buyer })).json;
    show('我的·角标（取消后）', orderShortcuts(counts2));
    show('库存', await stockOf());
    expectReadable({ d, s1: orderShortcuts(counts1), s2: orderShortcuts(counts2) });
    expect(r.status).toBe(200);
    const badge = (s: ReturnType<typeof orderShortcuts>, label: string) =>
      s.find((x) => x.label === label)?.badge;
    expect(badge(orderShortcuts(counts1), '待付款')).toBe('1');
    expect(badge(orderShortcuts(counts2), '待付款')).toBe(''); // 取消后角标消失，不留"0"
    expect(d).toMatchObject({ statusText: '已取消', canPay: false, canBuyAgain: true });
    expect(d.timeline.map((t) => t.statusText)).toEqual(['提交订单', '订单已取消']);
    expect(await stockOf()).toBe(3);
  });
});

/** 第三条旅程的共享状态：车里两件，其中一件被下架；另一张已付单在发货前改址。 */
const M = { keep: 'p-sencha', gone: 'p-yuzu', orderId: '' };

describe('中途变化：车里的商品被下架、发货前改地址——买家与运营各自看到的话', () => {
  beforeAll(async () => {
    await db`
      insert into products (id, title, title_ja, category, price_jpy, weight_g, stock, origin_country, status,
                            customs_desc_en, hs_code)
      values (${M.keep}, '丸山园 静冈深蒸煎茶 100g', '丸山園 静岡深蒸し煎茶 100g', 'food', 1620, 130, 20, 'JP',
              'active', 'green tea leaves', '0902.10'),
             (${M.gone}, '马路村 柚子醋 500ml', '馬路村 ゆずの村 ぽん酢 500ml', 'food', 980, 620, 20, 'JP',
              'active', 'yuzu ponzu sauce', '2103.90')`;
  });

  it('⑪ 加购两件后运营下架其中一件 → 报价 40401 → 购物车标出那一行、说清怎么办', async () => {
    const rows = cartRows([
      { productId: M.keep, title: '丸山园 静冈深蒸煎茶 100g', priceJpy: 1620, qty: 1 },
      { productId: M.gone, title: '马路村 柚子醋 500ml', priceJpy: 980, qty: 1 },
    ]);
    await setProductStatus(admin(), M.gone, 'offline');
    const q = await call(srv, 'POST', '/api/v1/orders/quote', {
      token: buyer,
      body: {
        items: [
          { product_id: M.keep, qty: 1 },
          { product_id: M.gone, qty: 1 },
        ],
        address_id: 'addr-chen',
      },
    });
    show('报价（含已下架）', { status: q.status, json: q.json });
    const marked = markInvalid(
      rows,
      (q.json['data'] as { product_id?: string } | undefined)?.product_id,
      q.json['code'],
    );
    show('购物车标记', marked);
    expectReadable(marked);
    expect(q.json['code']).toBe(40401);
    // 只标被下架的那一行，另一行不受牵连（标错一行比不标更糟：用户会删掉好好的商品）
    expect(marked.map((r) => r.invalidText)).toEqual(['', '已下架或不存在，请移除']);
  });

  it('⑫ 已付单发货前运营改址 → 买家详情是新地址；时间线记"改址"；填 NY + 内华达邮编被拒且说人话', async () => {
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-readdr',
      body: {
        items: [{ product_id: M.keep, qty: 2 }],
        address_id: 'addr-chen',
        terms_version: CHAIN_TERMS,
      },
    });
    M.orderId = String(c.json['order_id']);
    await call(srv, 'POST', `/api/v1/orders/${M.orderId}/pay`, {
      token: buyer,
      key: 'pay-readdr',
      body: { channel: 'mock' },
    });
    expect((await mockCallback(srv, db, M.orderId, { eventId: 'evt-readdr' })).status).toBe(200);

    const form = {
      ...addressFormModel(await getOrder(admin(), M.orderId)),
      line1: '350 5th Ave',
      line2: 'Ste 4710',
      city: 'New York',
      state: 'NY',
    };
    // 先手滑：州改了、邮编还是旧金山的 94133 → 前端预检拦；绕过前端直发也被服务端拒（AJ-496）
    show('后台改址预检（州与邮编对不上）', addressFormErrors(form));
    let rejected: unknown = null;
    try {
      await updateOrderAddress(admin(), M.orderId, toAddressInput(form));
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown; data?: unknown };
      rejected = { code: err.code, message: err.message, text: addressRejectText(err.data) };
    }
    show('服务端拒绝（绕过前端）', rejected);

    await updateOrderAddress(admin(), M.orderId, toAddressInput({ ...form, postal_code: '10118' }));
    const d = await buyerDetail(M.orderId);
    show('小程序详情（改址后）', d.address);
    const order = await getOrder(admin(), M.orderId);
    const settings = (await call(srv, 'GET', '/api/v1/admin/settings', { token: adminToken })).json;
    const labels = channelLabelsFrom(settings as never);
    const events = (
      ((order as unknown as Record<string, unknown>)['events'] as unknown[]) ?? []
    ).map((e) => {
      const ev = e as Record<string, unknown>;
      return `${eventStatusText(ev['status'])} · ${eventActorText(ev, labels)} · ${eventNoteView(ev['status'], ev['note']).text}`;
    });
    show('后台时间线（改址后）', events);
    expectReadable({ address: d.address, events, rejected });
    // 前端预检先拦，并说清哪个州、哪个邮编
    expect(addressFormErrors(form).errors['postal_code']).toBe(
      '邮编 94133 不属于 New York（NY）——请检查州或邮编',
    );
    // 绕过前端：服务端拒（AJ-496），并带出原因，客户端说"邮编和州对不上"而不是"须为英文"（AJ-498）
    expect(rejected).toMatchObject({ code: 40002, text: '邮编和州对不上：请检查州或邮编' });
    expect(d.address).toMatchObject({
      line1: '350 5th Ave',
      line2: 'Ste 4710',
      region: 'New York, NY 10118',
    });
    expect(events.at(-1)).toBe('改址 · admin@example.com · 改址：改前地址已归档（#1）');
  });
});

/** 第四条旅程：付款后买家发起拒付 → 后台锁发货、风控列表、拉黑提示 → 结案胜诉 → 放行发货。 */
const DP = { orderId: '', orderNo: '' };

describe('拒付：开案锁住发货 → 风控页看得懂 → 结案后放行', () => {
  it('⑬ 已付单被拒付 → 后台列表与发货闸门、风控列表、拉黑提示都说人话', async () => {
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-dispute',
      body: {
        items: [{ product_id: M.keep, qty: 1 }],
        address_id: 'addr-chen',
        terms_version: CHAIN_TERMS,
      },
    });
    DP.orderId = String(c.json['order_id']);
    DP.orderNo = String(c.json['order_no']);
    await call(srv, 'POST', `/api/v1/orders/${DP.orderId}/pay`, {
      token: buyer,
      key: 'pay-dispute',
      body: { channel: 'mock' },
    });
    expect((await mockCallback(srv, db, DP.orderId, { eventId: 'evt-dispute' })).status).toBe(200);
    // 拒付由 Stripe 回调开案（mock 通道没有拒付事件）：与 admin-buyer-consistency 同口径直接落库
    await db`update orders set has_dispute = true where id = ${DP.orderId}`;
    await db`update payments set dispute_id = 'dp_journey', dispute_status = 'open',
                                 dispute_amount = 3770, dispute_opened_at = now()
              where order_id = ${DP.orderId}`;

    const row = adminOrderRows((await listOrders(admin())).items).find((r) => r.id === DP.orderId);
    show('后台订单行（拒付中）', row);
    let shipErr: unknown = null;
    try {
      await shipOrder(admin(), DP.orderId, {
        carrier: 'Japan Post EMS',
        tracking_no: 'EJ987654321JP',
      });
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown };
      shipErr = { code: err.code, message: err.message };
    }
    show('拒付中发货', shipErr);
    const disputes = disputeRows(await listDisputes(admin()));
    show(
      '风控拒付行',
      disputes.filter((d) => d.orderId === DP.orderId),
    );
    show('拉黑成功提示（风控页按订单拉黑）', blockDoneText(DP.orderNo));
    const d = await buyerDetail(DP.orderId);
    show('小程序详情（拒付中）', { statusText: d.statusText, nextText: d.nextText });
    expectReadable({ row, shipErr, disputes, d: { s: d.statusText, n: d.nextText } });
    expect(row?.hasDispute).toBe(true);
    expect(row?.actions.ship).toEqual({
      ok: false,
      reason: '有拒付进行中，先处理拒付再发货（发货后钱货两空）',
    });
    expect(shipErr).toMatchObject({ code: 40909 }); // 绕过闸门直发也被服务端拦
    expect(disputes.find((x) => x.orderId === DP.orderId)).toMatchObject({
      orderNo: DP.orderNo,
      statusText: '进行中',
      amountText: '3,770 日元',
      urgent: true,
    });
    // 拉黑提示认订单号、不写用户 id（2026-10-12 修过）
    expect(blockDoneText(DP.orderNo)).toBe(
      `已拉黑 订单 ${DP.orderNo} 的买家：此后无法下单；其名下未付款订单已一并取消（到「订单管理」核对）`,
    );
    expectReadable(blockDoneText(DP.orderNo));
    // @limitation 买家端拒付期间仍显示"已付款 · 日本采购中"（买家 Order 不带拒付标记）——记为未做，见测试缺口复盘 §6
    expect(d.statusText).toBe('已付款 · 日本采购中');
  });

  it('⑭ 结案胜诉 → 后台不再标拒付、可以发货；买家看到已发货', async () => {
    await markDisputeClosed(db, srv.events, DP.orderId, {
      channel: 'mock',
      disputeId: 'dp_journey',
      result: 'won',
    });
    const row = adminOrderRows((await listOrders(admin())).items).find((r) => r.id === DP.orderId);
    show('后台订单行（结案后）', row);
    await shipOrder(admin(), DP.orderId, {
      carrier: 'Japan Post EMS',
      tracking_no: 'EJ987654321JP',
    });
    const d = await buyerDetail(DP.orderId);
    show('小程序详情（结案后发货）', { statusText: d.statusText, trackingNo: d.trackingNo });
    expectReadable({ row, s: d.statusText });
    expect(row?.hasDispute).toBe(false);
    expect(row?.actions.ship.ok).toBe(true);
    expect(d).toMatchObject({ statusText: '已发货 · 国际运输中', trackingNo: 'EJ987654321JP' });
  });
});
