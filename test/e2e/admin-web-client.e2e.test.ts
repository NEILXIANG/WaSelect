/**
 * 职责：**管理端前后端接缝**（测试审查第二轮补测，AJ-175）——admin-web 的**真实**请求封装
 *      （`createAdminApi` / 各模块 `api.ts` / `uploadImage`）与 view-model（`view.ts`）
 *      直接打**真服务端**（生产装配 + 真库），断言运营最终看到的行、按钮闸门与错误码。
 *
 * @why admin-web 的单测全部用手写响应 fixture，服务端测试证明它返回契约形状——
 *      但"前端的请求体服务端收不收""前端的闸门与服务端的判定是否一致"从没被一起验过。
 *      本轮就在这条缝上抓到两处不一致（均已修，见 AJ-175）：
 *      ① 服务端改为"停在 refunding 可重试"（KD-4）后，前端 `refundGate` 仍把 refunding 拦成
 *        "不要重复提交"——服务端的修复在界面上**无入口**；
 *      ② `uploadImage` 把服务端的业务码（40001 图片解不开 / 40101 登录过期）一律折成
 *        "HTTP 400/401"的网络错，且不触发 onUnauthorized——运营看到"上传失败（HTTP 401）"却不被带回登录页。
 * @why 期望值独立写出（`'20,150 円'`、`'待发货'`），不调被测的格式化函数算期望。
 *
 * @limitation 一：**登录不在这里**：`POST /auth/admin/login` 服务端尚未实现（审计 P2-11，未开工的业务单元），
 *              token 用与生产同一签发函数直接签（chain-server `tokenFor`）。登录接缝在该路由落地时补。
 * @limitation 二：React 组件的渲染与交互不在这里（admin-web 无组件测试框架，同小程序约束十一的处境）；
 *              这里验的是组件之下那一层：请求封装 + 纯函数 view-model。
 *
 * @see admin-web/src/api/client.ts、upload.ts；admin-web/src/{products,orders}/{api,view}.ts；
 *      test/helpers/chain-server.ts；docs/自主决策记录.md AJ-175
 */
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import {
  buildChainServer,
  call,
  mockCallback,
  orderBody,
  seedChainFixture,
  tokenFor,
  type ChainServer,
} from '../helpers/chain-server.js';
import { createAdminApi } from '../../admin-web/src/api/client.js';
import { ApiError } from '../../admin-web/src/api/errors.js';
import { uploadImage } from '../../admin-web/src/api/upload.js';
import {
  createProduct,
  listProducts,
  setProductStatus,
  updateProduct,
} from '../../admin-web/src/products/api.js';
import {
  emptyProductForm,
  productFormErrors,
  productFormModel,
  productRows,
  toProductInput,
} from '../../admin-web/src/products/view.js';
import { getOrder, listOrders, refundOrder } from '../../admin-web/src/orders/api.js';
import { orderRows, paymentSummary, refundGate } from '../../admin-web/src/orders/view.js';

const IMG_BASE = 'https://img.example.test';

let db: Db;
let srv: ChainServer;
let adminToken = '';
let unauthorized: ApiError[] = [];

function adminApi(token: () => string = () => adminToken) {
  return createAdminApi({
    baseUrl: srv.url,
    getToken: token,
    onUnauthorized: (e) => unauthorized.push(e),
  });
}

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  srv = await buildChainServer(db, { IMG_BASE_URL: IMG_BASE });
}, 30_000);

afterAll(async () => {
  await srv.close();
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
  adminToken = await tokenFor('u-admin', 'admin');
  unauthorized = [];
});

describe('商品：表单 → 真服务端 → 列表行', () => {
  it('新建 → 列表行文案；编辑期间买家下单 → 只改标题保存不覆盖库存；显式改库存生效；下架后编辑仍是下架', async () => {
    const api = adminApi();
    const form = {
      ...emptyProductForm(),
      title: 'Deba Knife 出刃包丁 165mm',
      category: 'kitchen',
      priceJpy: '12800',
      weightG: '540',
      stock: '7',
      customsDescEn: 'kitchen knife, stainless steel',
    };
    expect(productFormErrors(form).ok).toBe(true);
    const created = await createProduct(api, toProductInput(form));

    const row = productRows((await listProducts(api)).items).find((r) => r.id === created.id);
    expect(row).toMatchObject({
      title: 'Deba Knife 出刃包丁 165mm',
      priceText: '12800 円',
      stockText: '7',
      statusText: '在售',
      online: true,
    });

    // 运营打开编辑页（表单从列表项来，读到库存 7）……
    const source = (await listProducts(api)).items.find((p) => p.id === created.id);
    const editForm = productFormModel(source);
    const originalStock = editForm.stock;
    // ……此时买家下单买走 1 件
    const buyer = await tokenFor('u-1');
    const o = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-seam',
      body: {
        items: [{ product_id: created.id, qty: 1 }],
        address_id: 'addr-1',
        terms_version: 'TOS-TEST-1',
      },
    });
    expect(o.status).toBe(201);
    // ……运营只改了标题就保存
    await updateProduct(
      api,
      created.id,
      toProductInput({ ...editForm, title: 'Deba Knife 出刃包丁' }, originalStock),
    );
    const after = productRows((await listProducts(api)).items).find((r) => r.id === created.id);
    expect(after?.title).toBe('Deba Knife 出刃包丁');
    expect(after?.stockText).toBe('6'); // 不是打开页面时的 7

    // 显式改库存 → 生效
    await updateProduct(
      api,
      created.id,
      toProductInput({ ...editForm, stock: '20' }, originalStock),
    );
    expect(
      productRows((await listProducts(api)).items).find((r) => r.id === created.id)?.stockText,
    ).toBe('20');

    // 下架后再编辑 → 仍是下架（PUT 不碰上下架）
    await setProductStatus(api, created.id, 'offline');
    await updateProduct(api, created.id, toProductInput({ ...editForm, title: '改个名' }, '20'));
    const off = productRows((await listProducts(api)).items).find((r) => r.id === created.id);
    expect(off?.statusText).toBe('已下架');
    expect(off?.online).toBe(false);
  });
});

describe('订单：真服务端 → 列表行与闸门；闸门与服务端判定一致', () => {
  async function paidOrder(): Promise<string> {
    const buyer = await tokenFor('u-1');
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-o',
      body: orderBody(),
    });
    const id = String(c.json['order_id']);
    await call(srv, 'POST', `/api/v1/orders/${id}/pay`, {
      token: buyer,
      key: 'p-o',
      body: { channel: 'mock' },
    });
    expect((await mockCallback(srv, db, id, { eventId: 'evt-seam' })).status).toBe(200);
    return id;
  }

  it('已付单：列表行"待发货 / 20,150 円"、可退；拒付中闸门拦且服务端同样 40907（错误码与链路 ID 带回前端）', async () => {
    const api = adminApi();
    const id = await paidOrder();
    const row = orderRows((await listOrders(api)).items).find((r) => r.id === id);
    expect(row?.statusText).toBe('待发货');
    expect(row?.totalText).toBe('20,150 円');
    expect(row?.recipientText).toBe('Jane Doe');
    expect(row?.actions.refund.ok).toBe(true);
    expect(row?.actions.ship.ok).toBe(true);

    // 详情的支付摘要：渠道 + 原币金额（契约 Order.payment.channel；一致性审计 C5，AJ-176）
    expect(paymentSummary(await getOrder(api, id))).toMatch(/^mock /);

    await db`update orders set has_dispute = true where id = ${id}`;
    const detail = await getOrder(api, id);
    const gate = refundGate(detail);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('40907');
    // 前端闸门说拦 → 服务端也确实拦（若有人绕过按钮直接调，得到的是同一个码）
    const err = await refundOrder(api, id, { reason: '缺货' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(40907);
    expect((err as ApiError).traceId).toMatch(/[0-9a-f-]{8,}/);
    expect(JSON.stringify(srv.sink.lines)).toContain((err as ApiError).traceId); // 报障码能在服务端日志里查到
  });

  it('停在"退款中"（上次机构调用失败）：前端闸门放行重试且给出提示 → 服务端 202 → 已退款后闸门再拦', async () => {
    const api = adminApi();
    const id = await paidOrder();
    // 模拟"上次退款机构调用失败"留下的现场：refunding + 首次原因事件（与路由失败路径写库一致）
    await db`update orders set status = 'refunding' where id = ${id}`;
    await db`insert into order_events (order_id, status, actor, note, at) values (${id}, 'refunding', 'admin', '缺货', now())`;
    const g = refundGate(await getOrder(api, id));
    expect(g.ok).toBe(true); // KD-4：服务端允许重试，前端不能把唯一入口堵死
    expect(g.reason).toContain('重试');
    await refundOrder(api, id, { reason: '再试一次' });
    const done = await getOrder(api, id);
    expect(done.status).toBe('refunded');
    expect(refundGate(done)).toEqual({ ok: false, reason: '已退款' });
  });
});

describe('上传：admin-web 的 multipart 封装 → 真上传路由（sharp 真解码）', () => {
  async function png(): Promise<File> {
    const buf = await sharp({
      create: { width: 900, height: 900, channels: 3, background: '#b0303a' },
    })
      .png()
      .toBuffer();
    return new File([buf], 'knife.png', { type: 'image/png' });
  }

  it('真 PNG → 三档 URL（IMG_BASE_URL 前缀）+ image_key；三档可直接作为商品图提交', async () => {
    const up = await uploadImage({ baseUrl: srv.url, getToken: () => adminToken }, await png());
    expect(up.image_key).not.toBe('');
    for (const k of ['thumb', 'card', 'detail'] as const) {
      expect(up[k]?.startsWith(`${IMG_BASE}/`)).toBe(true);
    }
    const api = adminApi();
    const created = await createProduct(
      api,
      toProductInput({
        ...emptyProductForm(),
        title: 'Tea Bowl 茶碗',
        category: 'kitchen',
        priceJpy: '4200',
        weightG: '380',
        customsDescEn: 'ceramic tea bowl',
        images: [{ thumb: up.thumb ?? '', card: up.card ?? '', detail: up.detail ?? '' }],
      }),
    );
    const [p] = await db`select images from products where id = ${created.id}`;
    expect(JSON.stringify(p?.['images'])).toContain(up.detail ?? '<none>');
  });

  it('坏图 → 前端拿到服务端业务码 40001（不是折成 HTTP 400 的网络错）', async () => {
    const bad = new File([Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(56), 'binary')], 'bad.png', {
      type: 'image/png',
    });
    const err = await uploadImage({ baseUrl: srv.url, getToken: () => adminToken }, bad).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(40001);
    expect((err as ApiError).traceId).not.toBe('');
  });

  it('登录过期 → 40101 且触发 onUnauthorized（与 JSON 请求同一出口：带回登录页）', async () => {
    const expired: ApiError[] = [];
    const err = await uploadImage(
      {
        baseUrl: srv.url,
        getToken: () => 'not-a-valid-token',
        onUnauthorized: (e) => expired.push(e),
      },
      await png(),
    ).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(40101);
    expect(expired).toHaveLength(1);

    // 同一口径：JSON 请求封装在 40101 时也触发（基线对照）
    const api = adminApi(() => 'not-a-valid-token');
    await listProducts(api).catch(() => undefined);
    expect(unauthorized).toHaveLength(1);
  });
});
