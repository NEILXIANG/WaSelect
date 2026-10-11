/**
 * 职责：**前后端接缝**——把真服务端（生产装配 + 真库）返回的响应**原样**喂给小程序页面的
 *      view-model 纯函数（`*.vm.js`），断言用户最终看到的文案与数字（测试审查 U-J10）。
 *
 * @why 小程序这一侧的测试全部用手写 fixture：vm 的单测证明"给它契约形状它就渲染对"，
 *      服务端的测试证明"它返回契约形状"——但**两边对"契约形状"的理解是否一致**，
 *      此前没有任何一条测试检验过。服务端把 `total_jpy` 改名、把 `items` 包一层、
 *      把 `status` 换成另一套词，vm 单测与服务端测试**都会照样绿**，
 *      而真机上用户看到的是空白的金额、"状态未知"的标签、消失的商品图。
 *      miniprogram-shell.e2e 虽然打的是真服务端，但它只验传输层（request.js），**不调任何 vm**。
 * @why 断言的是**最终文案**（`'20,150 円'`、`'待付款'`、`'Cupertino, CA 95014'` 这一级），
 *      而不是"字段存在"：字段在、但单位/格式/映射错了，用户照样看错。
 *      期望值独立写出（不调用被测的格式化函数算期望），否则就是自证。
 *
 * @limitation 一：WXML 绑定、组件渲染、真机样式不在这里（约束十一：那些只能真机验）。
 * @limitation 二：覆盖首页卡片、商品详情、订单列表 / 详情、地址列表，以及（测试审计 T-2，2026-10-09 补）
 *              报价区（购物车 / 结算共用的 quote-view + 购物车按报价刷新单价 + 扣款预告）、支付页（通道按钮、
 *              支付意图分流）、同类推荐（列表响应进详情页）、再次购买（订单响应进购物车再报价）。
 *              结算页的 `orderBody` 是"写"方向，其请求体被服务端接受已由 miniprogram-shell.e2e 覆盖。
 * @why T-2 的真实案例：同类推荐按详情的 `images[]` 读了列表的 `image`，测试数据也照着错的形状写，
 *      单测全绿、模拟器里图全是占位——这一类只有"真服务端响应喂 vm"能拦住。
 *
 * @see miniprogram/pages/{home,detail,order,order-detail,address}/index.vm.js；
 *      test/helpers/chain-server.ts；docs/自主决策记录.md AJ-174
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import {
  buildChainServer,
  call,
  CHAIN_ITEMS,
  CHAIN_TOTAL_JPY,
  mockCallback,
  orderBody,
  seedChainFixture,
  tokenFor,
  type ChainServer,
} from '../helpers/chain-server.js';
import { productCards } from '../../miniprogram/pages/home/index.vm.js';
import { detailView as productDetailView } from '../../miniprogram/pages/detail/index.vm.js';
import { orderRows } from '../../miniprogram/pages/order/index.vm.js';
import { detailView as orderDetailView } from '../../miniprogram/pages/order-detail/index.vm.js';
import { addressRows } from '../../miniprogram/pages/address/index.vm.js';
import { orderShortcuts } from '../../miniprogram/pages/user/index.vm.js';
import { tabItems, tabStatusParam } from '../../miniprogram/utils/order-tabs.js';
import { PLACEHOLDER_IMAGE } from '../../miniprogram/utils/placeholder.js';
import { quoteView } from '../../miniprogram/utils/quote-view.js';
import { createCartStore } from '../../miniprogram/utils/cart-store.js';
import { createStorage } from '../../miniprogram/utils/storage.js';
import { createWxApi } from '../../miniprogram/utils/wx-api.js';
import { chargeOptions, chargePreview, payPlan } from '../../miniprogram/utils/pay-plan.js';
import { payPageView } from '../../miniprogram/pages/pay/index.vm.js';
import { relatedCards } from '../../miniprogram/pages/detail/index.vm.js';
import { buyAgainItems } from '../../miniprogram/pages/order-detail/index.vm.js';

let db: Db;
let srv: ChainServer;
let buyer = '';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  srv = await buildChainServer(db);
}, 30_000);

afterAll(async () => {
  await srv.close();
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
  buyer = await tokenFor('u-1');
});

describe('真服务端响应 → 小程序 view-model → 用户看到的文案', () => {
  it('首页卡片与商品详情：价格是整数円、有副行汇率、库存 0 显示售罄', async () => {
    await db`update products set stock = 0 where id = 'p-cup'`;
    const list = await call(srv, 'GET', '/api/v1/products?size=50');
    expect(list.status).toBe(200);
    const cards = productCards(list.json['items']);
    const knife = cards.find((c) => c.id === 'p-knife');
    const cup = cards.find((c) => c.id === 'p-cup');
    expect(knife?.title).toBe('Chef Knife');
    expect(knife?.priceJpy).toBe(8800); // 整数：交给 ws-price 的必须是整数
    expect(knife?.subPrice).toMatch(/^≈ \$\d+\.\d{2} · ≈ ¥\d+(\.\d{2})?$/); // 两个展示币都在
    expect(knife?.soldOut).toBe(false);
    expect(cup?.soldOut).toBe(true);

    const d = await call(srv, 'GET', '/api/v1/products/p-knife');
    const v = productDetailView(d.json);
    expect(v.title).toBe('Chef Knife');
    expect(v.priceJpy).toBe(8800);
    expect(v.subPrice).toBe(knife?.subPrice); // 列表与详情同一价格同一副行
    expect(v.specs).toEqual([
      { label: '原产地', value: expect.any(String) as string },
      { label: '重量', value: '约 620 g' },
    ]);
  });

  it('订单列表与订单详情：状态文案、金额、可付/可取消开关、地址摘要、时间线随真实状态变化', async () => {
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-vm',
      body: orderBody(),
    });
    const orderId = String(c.json['order_id']);

    // ── 待付款 ─────────────────────────────────────────────────────────────
    const rows = orderRows(
      (await call(srv, 'GET', '/api/v1/orders', { token: buyer })).json['items'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orderId).toBe(orderId);
    expect(rows[0]?.totalJpy).toBe(CHAIN_TOTAL_JPY);
    expect(rows[0]?.totalText).toBe('20,150 円');
    expect(rows[0]?.statusText).not.toBe('状态未知'); // 服务端状态词必须在前端词表里
    expect(rows[0]?.canPay).toBe(true);

    const d1 = orderDetailView(
      (await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: buyer })).json,
    );
    expect(d1.statusText).toBe(rows[0]?.statusText); // 列表与详情同一状态同一文案
    expect(d1.canPay).toBe(true);
    expect(d1.canCancel).toBe(true);
    expect(d1.totalJpy).toBe(CHAIN_TOTAL_JPY);
    // 行序不是契约承诺（服务端按 product_id 排），按品名排序后比
    expect(
      d1.items
        .map((i) => [i.title, i.qty, i.unitPriceText])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['Chef Knife', 1, '8,800 円'],
      ['Tea Cup', 2, '3,200 円'],
    ]);
    expect(d1.amountLines.map((l) => l.value).slice(0, 2)).toEqual(['15,200 円', '4,950 円']);
    expect(d1.address?.recipient).toBe('Jane Doe');
    expect(d1.expiresAtText).not.toBe(''); // 可付时显示截止时刻
    expect(d1.timeline).toHaveLength(1);

    // ── 付款后 ─────────────────────────────────────────────────────────────
    await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
      token: buyer,
      key: 'pay-vm',
      body: { channel: 'mock' },
    });
    expect((await mockCallback(srv, db, orderId, { eventId: 'evt-vm' })).status).toBe(200);
    const d2 = orderDetailView(
      (await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: buyer })).json,
    );
    // 测试改动（AJ-407 跑全量 gate 时发现）：M-06 / AJ-405 已批准买家视角文案 paid → "已付款 · 日本采购中"（miniprogram/utils/order-status.js），此处期望值未随之更新
    expect(d2.statusText).toBe('已付款 · 日本采购中');
    expect(d2.canPay).toBe(false);
    expect(d2.canCancel).toBe(false);
    expect(d2.expiresAtText).toBe(''); // 已付不再显示截止时刻
    expect(d2.timeline.map((t) => t.statusText)).toHaveLength(3);
    expect(d2.timeline.every((t) => t.atText !== '')).toBe(true); // 时刻被转成了 JST 文案
    const rows2 = orderRows(
      (await call(srv, 'GET', '/api/v1/orders', { token: buyer })).json['items'],
    );
    // 同上（M-06 / AJ-405：列表行与详情状态区同一张买家视角词表）
    expect(rows2[0]?.statusText).toBe('已付款 · 日本采购中');
    expect(rows2[0]?.canPay).toBe(false);
  });

  it('AJ-408（M-10 / M-11 / M-12）：页签参数真被服务端接受、列表行时间 / 缩略图 / 件数、「我的」角标、详情进度条', async () => {
    // 第一行商品（p-knife）给一张图；第二行（p-cup）保持无图——首图只看第一行
    await db`update products set images = ${db.json(['https://img.example.com/knife.jpg'])} where id = 'p-knife'`;
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-tabs',
      body: orderBody(),
    });
    const orderId = String(c.json['order_id']);

    // ── 页签：vm 生成的查询参数原样发给真服务端（逗号多选），各页签各取各的 ──
    const list = async (tab: string): Promise<Array<Record<string, unknown>>> => {
      const q = tabStatusParam(tab);
      const r = await call(srv, 'GET', `/api/v1/orders${q === '' ? '' : `?status=${q}`}`, {
        token: buyer,
      });
      expect([tab, r.status]).toEqual([tab, 200]);
      return r.json['items'] as Array<Record<string, unknown>>;
    };
    // 页面的真实路径是 `tabItems(页签, 响应)`：AJ-430 起「售后·退款」不带 status、拿全量再本地按 after_sale_state 筛
    const shown = async (tab: string) => tabItems(tab, await list(tab));
    expect((await shown('unpaid')).map((o) => o['order_id'])).toEqual([orderId]);
    expect(await shown('to_ship')).toEqual([]);
    expect(tabStatusParam('after_sale')).toBe('');
    expect((await list('after_sale')).map((o) => o['after_sale_state'])).toEqual([null]);
    expect(await shown('after_sale')).toEqual([]);

    // ── 列表行（M-11）──
    const [row] = orderRows(await list('all'));
    expect(row?.itemCountText).toBe('共 3 件'); // knife×1 + cup×2
    expect(row?.thumb).toBe('https://img.example.com/knife.jpg');
    expect(row?.thumb).not.toBe(PLACEHOLDER_IMAGE);
    expect(row?.createdText).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（日本时间）$/);
    // AJ-435（契约 0.6.61）：真服务端列表行下发 expires_at，待付款行写出截止时刻。
    // 严格检查补测（2026-10-10）：只验格式时 vm 误用 created_at 也会过——这里按同一行的 expires_at 独立换算日本时间，整句精确比对
    const rawRow = (await list('all'))[0];
    const exp = new Date(Date.parse(String(rawRow?.['expires_at'])) + 9 * 3600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const jst = `${String(exp.getUTCFullYear())}-${pad(exp.getUTCMonth() + 1)}-${pad(exp.getUTCDate())} ${pad(exp.getUTCHours())}:${pad(exp.getUTCMinutes())}`;
    expect(rawRow?.['expires_at']).not.toBe(rawRow?.['created_at']);
    expect(row?.nextText).toBe(`请在 ${jst}（日本时间）前完成支付，超时订单会自动关闭。`);

    // ── 「我的」角标（M-10 附）：同一次全量列表本地分组 ──
    expect(orderShortcuts(await list('all')).map((s) => s.badge)).toEqual(['1', '', '', '']);

    // ── 详情进度条（M-12）：待付款 → 付款是当前步；付款后 → 采购是当前步，进「采购中」页签 ──
    const p1 = orderDetailView(
      (await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: buyer })).json,
    ).progress;
    expect(p1.steps.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
    await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
      token: buyer,
      key: 'pay-tabs',
      body: { channel: 'mock' },
    });
    expect((await mockCallback(srv, db, orderId, { eventId: 'evt-tabs' })).status).toBe(200);
    const p2 = orderDetailView(
      (await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: buyer })).json,
    ).progress;
    expect(p2.steps.map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    expect((await list('to_ship')).map((o) => o['order_id'])).toEqual([orderId]);
    expect(await list('unpaid')).toEqual([]);
  });

  it('地址列表：真实响应 → 行视图（id 可点、默认标记、地区摘要）', async () => {
    const r = await call(srv, 'GET', '/api/v1/addresses', { token: buyer });
    expect(r.status).toBe(200);
    const list = Array.isArray(r.json) ? r.json : (r.json['items'] as unknown);
    const rows = addressRows(list);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('addr-1');
    expect(rows[0]?.recipient).toBe('Jane Doe');
    expect(rows[0]?.isDefault).toBe(true);
    expect(rows[0]?.defaultText).toBe('默认');
    expect(rows[0]?.region).toContain('Cupertino');
    expect(rows[0]?.region).toContain('95014');
  });
});

/** 购物车：与小程序同一份 cart-store + 同一份 storage 封装，只把宿主存储换成内存（与 cart-store 单测同法）。 */
function memoryCart(): ReturnType<typeof createCartStore> {
  const data: Record<string, string> = {};
  const wx = createWxApi({
    getStorageSync: (k) => data[k] ?? '',
    setStorageSync: (k, v) => {
      data[k] = String(v);
    },
    removeStorageSync: (k) => {
      delete data[k];
    },
  });
  return createCartStore({ storage: createStorage({ wx }) });
}

/** 支付页 / 结算页查通道的同一组请求（JPY、USD 各一次，与 pay/index.js、checkout/index.js 同参）。 */
async function channelListings(
  s: ChainServer,
  token: string,
  totalJpy: unknown,
): Promise<Array<{ currency: string; resp: unknown }>> {
  const out: Array<{ currency: string; resp: unknown }> = [];
  for (const currency of ['JPY', 'USD']) {
    const r = await call(
      s,
      'GET',
      `/api/v1/pay/channels?country=US&currency=${currency}&amount_jpy=${String(totalJpy)}`,
      { token },
    );
    expect([currency, r.status]).toEqual([currency, 200]);
    out.push({ currency, resp: r.json });
  }
  return out;
}

describe('真服务端响应 → 购物车 / 结算 / 支付 / 推荐 / 再次购买（测试审计 T-2）', () => {
  it('报价区：购物车请求体被接受、各行与合计是整数円文案、购物车按报价刷新过期单价、结算页扣款预告', async () => {
    const cart = memoryCart();
    cart.add({ productId: 'p-knife', qty: 1, title: 'Chef Knife', priceJpy: 8800 });
    cart.add({ productId: 'p-cup', qty: 2, title: 'Tea Cup', priceJpy: 3000 }); // 加购后店家改过价
    const q = await call(srv, 'POST', '/api/v1/orders/quote', {
      token: buyer,
      body: { items: cart.toOrderItems() },
    });
    expect(q.status).toBe(200);
    const v = quoteView(q.json);
    // MP-11（第二轮审计）：关税不再与商品 / 运费并列成第三行，改为合计下方一句（hints 第一句）
    expect(v.lines.map((l) => l.label)).toEqual(['商品合计', '运费']);
    expect(v.lines.map((l) => l.value)).toEqual(['15,200 円', '4,950 円']);
    expect(v.hints[0]).toMatch(/^其中预估关税 \d{1,3}(,\d{3})* 円（已含在商品价内）$/);
    expect([v.hasTotal, v.totalJpy, v.totalText]).toEqual([true, CHAIN_TOTAL_JPY, '20,150 円']);
    expect(v.totalSub).toMatch(/^≈ \$\d+\.\d{2} · ≈ ¥\d+(\.\d{2})?$/);
    expect(v.splitRequired).toBe(false);

    // 报价 lines 刷新购物车快照价（契约 0.6.39）：3000 → 3200，行价与合计对得上
    expect(cart.syncPrices(q.json['lines'])).toBe(true);
    expect(cart.items().map((i) => [i.productId, i.priceJpy])).toEqual([
      ['p-knife', 8800],
      ['p-cup', 3200],
    ]);

    // 结算页扣款预告（M-16）：报价 + 真实通道清单
    const listings = await channelListings(srv, buyer, q.json['total_jpy']);
    expect(chargePreview(chargeOptions(listings, q.json))).toEqual([
      '模拟支付将以日元扣款 20,150 円',
    ]);
  });

  it('支付页：按钮带实扣金额；非审核模式的模拟支付意图**绝不**判成"已完成"；审核模式判 auto，付完显示已付款', async () => {
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-pay',
      body: orderBody(),
    });
    const orderId = String(c.json['order_id']);
    const order = (await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: buyer })).json;
    expect(payPageView(order, Date.parse(String(order['created_at'])))).toEqual({
      payable: true,
      closedText: '',
      goHome: false,
    });
    const options = chargeOptions(await channelListings(srv, buyer, order['total_jpy']), order);
    expect(options.map((o) => o.buttonText)).toEqual(['模拟支付（20,150 円）']);

    // 非审核模式：服务端不会自动确认（payload.auto=false）→ 前端只能说"不可用"（AJ-179）
    const intent = await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
      token: buyer,
      key: 'pay-k',
      body: { channel: 'mock' },
    });
    expect(intent.status).toBe(200);
    expect(payPlan(intent.json).kind).toBe('unsupported');

    // 审核模式（MOCK_AUTO_CONFIRM=on）：同一条真实链路判 auto，响应回来时订单已是已付款
    const auto = await buildChainServer(db, { MOCK_AUTO_CONFIRM: 'on' });
    try {
      const c2 = await call(auto, 'POST', '/api/v1/orders', {
        token: buyer,
        key: 'k-pay-auto',
        body: orderBody(),
      });
      const id2 = String(c2.json['order_id']);
      const it2 = await call(auto, 'POST', `/api/v1/orders/${id2}/pay`, {
        token: buyer,
        key: 'pay-auto',
        body: { channel: 'mock' },
      });
      expect(payPlan(it2.json)).toEqual({ kind: 'auto' });
      const paid = (await call(auto, 'GET', `/api/v1/orders/${id2}`, { token: buyer })).json;
      expect(payPageView(paid, Date.parse(String(paid['created_at'])))).toEqual({
        payable: false,
        closedText: '已付款，无需再支付',
        goHome: false,
      });
    } finally {
      await auto.close();
    }
  });

  it('同类推荐：详情的分类 → 列表响应 → 卡片（排除本品、售罄与别的分类；图取列表行的单张 image）', async () => {
    await db`update products set images = ${db.json(['https://img.example.com/cup.jpg'])} where id = 'p-cup'`;
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
      values ('p-pan', 'Iron Pan', 'kitchen', 6600, 1500, 0, 'JP', 'active'),
             ('p-soap', 'Rice Soap', 'beauty', 1200, 100, 8, 'JP', 'active')`;
    const detail = productDetailView(
      (await call(srv, 'GET', '/api/v1/products/p-knife', { token: buyer })).json,
    );
    expect(detail.category).toBe('kitchen');
    const list = await call(srv, 'GET', `/api/v1/products?category=${detail.category}&size=10`, {
      token: buyer,
    });
    expect(list.status).toBe(200);
    expect(relatedCards(list.json['items'], 'p-knife')).toEqual([
      { id: 'p-cup', title: 'Tea Cup', image: 'https://img.example.com/cup.jpg', priceJpy: 3200 },
    ]);
  });

  it('再次购买：订单响应 → 购物车条目 → 真实报价通过且合计一致；改价后以新价为准', async () => {
    await db`update products set images = ${db.json(['https://img.example.com/cup.jpg'])} where id = 'p-cup'`;
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-again',
      body: orderBody(),
    });
    const orderId = String(c.json['order_id']);
    const order = (await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: buyer })).json;

    const cart = memoryCart();
    for (const i of buyAgainItems(order)) expect(cart.add(i)).toEqual({ added: true });
    expect(
      cart
        .items()
        .map((i) => [i.productId, i.qty, i.image])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['p-cup', 2, 'https://img.example.com/cup.jpg'],
      ['p-knife', 1, ''], // 没有图的商品存空串，购物车行显示占位图
    ]);
    expect(cart.toOrderItems().sort((a, b) => a.product_id.localeCompare(b.product_id))).toEqual(
      [...CHAIN_ITEMS].sort((a, b) => a.product_id.localeCompare(b.product_id)),
    );
    const q1 = await call(srv, 'POST', '/api/v1/orders/quote', {
      token: buyer,
      body: { items: cart.toOrderItems() },
    });
    expect([q1.status, quoteView(q1.json).totalJpy]).toEqual([200, order['total_jpy']]);

    // 店家改价：再次购买不带旧价，报价以新价为准（buyAgainItems @why）
    await db`update products set price_jpy = 9000 where id = 'p-knife'`;
    const q2 = await call(srv, 'POST', '/api/v1/orders/quote', {
      token: buyer,
      body: { items: cart.toOrderItems() },
    });
    expect(quoteView(q2.json).lines[0]?.value).toBe('15,400 円'); // 9000 + 3200×2
    expect(cart.syncPrices(q2.json['lines'])).toBe(true);
    expect(cart.items().find((i) => i.productId === 'p-knife')?.priceJpy).toBe(9000);
  });
});
