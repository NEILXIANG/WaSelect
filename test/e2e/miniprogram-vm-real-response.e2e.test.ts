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
 * @limitation 二：只覆盖"读"方向的主页面（首页卡片、商品详情、订单列表、订单详情、地址列表）；
 *              结算页的 `orderBody` 是"写"方向，其请求体被服务端接受已由 miniprogram-shell.e2e 覆盖。
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
