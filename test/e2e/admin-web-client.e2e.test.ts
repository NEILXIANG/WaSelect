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
  sourceUpdatedAt,
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
      hsCode: '8211.91',
    };
    expect(productFormErrors(form).ok).toBe(true);
    const created = await createProduct(api, toProductInput(form));

    // AJ-403（契约 0.6.46）：新建恒为草稿——列表行是「草稿」、买家看不见；上架走 PATCH /status
    const draftRow = productRows((await listProducts(api)).items).find((r) => r.id === created.id);
    expect(draftRow).toMatchObject({ statusText: '草稿', online: false });
    await setProductStatus(api, created.id, 'active');

    const row = productRows((await listProducts(api)).items).find((r) => r.id === created.id);
    expect(row).toMatchObject({
      title: 'Deba Knife 出刃包丁 165mm',
      priceText: '12,800 円',
      stockText: '7',
      statusText: '在售',
      online: true,
    });

    // 运营打开编辑页（表单从列表项来，读到库存 7）……
    const source = (await listProducts(api)).items.find((p) => p.id === created.id);
    const editForm = productFormModel(source);
    const originalStock = editForm.stock;
    const cred = sourceUpdatedAt(source); // ⬅ 乐观锁凭据（ADM3-02 / 契约 0.6.18）
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
    // ⚠️ 这一条同时钉住两件事：① AJ-175「编辑期间下单不覆盖库存」；
    //    ② DB3-02「下单**不**推进 updated_at」——否则这里会拿到 40914，
    //      而 AJ-175 的保证就没了（两条修复互为前提，缺一条这条用例就红）。
    await updateProduct(
      api,
      created.id,
      toProductInput({ ...editForm, title: 'Deba Knife 出刃包丁' }, originalStock),
      cred,
    );
    const after = productRows((await listProducts(api)).items).find((r) => r.id === created.id);
    expect(after?.title).toBe('Deba Knife 出刃包丁');
    expect(after?.stockText).toBe('6'); // 不是打开页面时的 7

    // 显式改库存 → 生效（上一次保存推进了 updated_at，凭据必须重新取）
    const again = (await listProducts(api)).items.find((p) => p.id === created.id);
    const form2 = productFormModel(again);
    await updateProduct(
      api,
      created.id,
      toProductInput({ ...form2, stock: '20' }, form2.stock),
      sourceUpdatedAt(again),
    );
    expect(
      productRows((await listProducts(api)).items).find((r) => r.id === created.id)?.stockText,
    ).toBe('20');

    // 下架后再编辑 → 仍是下架（PUT 不碰上下架）
    // ⚠️ 下架**会**推进 updated_at（它是商品信息的一部分），所以这里要重新取凭据
    await setProductStatus(api, created.id, 'offline');
    const third = (await listProducts(api)).items.find((p) => p.id === created.id);
    const form3 = productFormModel(third);
    await updateProduct(
      api,
      created.id,
      toProductInput({ ...form3, title: '改个名' }, form3.stock),
      sourceUpdatedAt(third),
    );
    const off = productRows((await listProducts(api)).items).find((r) => r.id === created.id);
    expect(off?.statusText).toBe('已下架');
    expect(off?.online).toBe(false);
  });

  it('两个运营同时编辑：B 先改价保存 → A 用旧凭据保存拿 40914，改价不被回滚', async () => {
    const api = adminApi();
    const created = await createProduct(
      api,
      toProductInput({
        ...emptyProductForm(),
        title: 'Deba Knife 出刃包丁 165mm',
        category: 'kitchen',
        priceJpy: '12800',
        weightG: '540',
        stock: '7',
        customsDescEn: 'kitchen knife, stainless steel',
        hsCode: '8211.91',
      }),
    );
    // A 打开编辑页（读到 12800）
    const seenByA = (await listProducts(api)).items.find((p) => p.id === created.id);
    const formA = productFormModel(seenByA);
    const credA = sourceUpdatedAt(seenByA);

    // B 把售价改成 15800 并保存
    await updateProduct(
      api,
      created.id,
      toProductInput({ ...formA, priceJpy: '15800' }, formA.stock),
      credA,
    );

    // A 拿着**打开页面时**的凭据只改标题 → 必须被拒
    const err = await updateProduct(
      api,
      created.id,
      toProductInput({ ...formA, title: 'A 改的标题' }, formA.stock),
      credA,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(40914); // 不是 40401：商品**在**，只是版本对不上
    expect((err as ApiError).traceId).toMatch(/[0-9a-f-]{8,}/);

    const row = (await listProducts(api)).items.find((p) => p.id === created.id);
    expect(row?.price_jpy).toBe(15800); // B 的改价没被 A 回滚
    expect(row?.title).toBe('Deba Knife 出刃包丁 165mm'); // A 的标题也没写进去
  });

  /**
   * 🔴 编辑口径三列（`products.why` / `maker` / `tags`，020 迁移新增）的**接缝**验证。
   *
   * 危害原型：`PUT /admin/products/{id}` 是**整行覆盖**。修复前 `toProductInput`
   * 不输出这三列 → 运营改个价格点保存，编辑撰写的 `why` 被写成 null，
   * **不报错、无提示、无法回滚**（商品表没有历史版本）。
   * 下面两条一起钉：① 三列在"只改价格"时原样存活；② 不带三列**确实**会被清空
   * （"省略即不改"在这三列上不成立——那是 `stock` 独有的口子）。
   */
  it('🔴 只改价格保存 → 编辑口径三列原样存活（不回传 = 抹掉）', async () => {
    const api = adminApi();
    const why = '三枚合钢，刃口崩了也磨得回来——但碳钢会锈，用完必须擦干。';
    const created = await createProduct(
      api,
      toProductInput({
        ...emptyProductForm(),
        title: 'Deba Knife 出刃包丁 165mm',
        category: 'kitchen',
        priceJpy: '12800',
        weightG: '540',
        stock: '7',
        customsDescEn: 'kitchen knife, stainless steel',
        hsCode: '8211.91',
        editorialWhy: why,
        editorialMaker: '堺 打刃物工房',
        editorialTags: ['堺打刃物', '碳钢'],
      }),
    );

    // 运营打开编辑页：三列从列表项进表单（这里断掉 = 表单是空的，保存即清空）
    const seen = (await listProducts(api)).items.find((p) => p.id === created.id);
    const form = productFormModel(seen);
    expect(form.editorialWhy).toBe(why);
    expect(form.editorialMaker).toBe('堺 打刃物工房');
    expect(form.editorialTags).toEqual(['堺打刃物', '碳钢']);

    // 只改价格保存（库存未动 → 不带 stock，AJ-175 那条同时成立）
    await updateProduct(
      api,
      created.id,
      toProductInput({ ...form, priceJpy: '13800' }, form.stock),
      sourceUpdatedAt(seen),
    );

    const after = (await listProducts(api)).items.find((p) => p.id === created.id);
    expect(after?.price_jpy).toBe(13800);
    // 🔴 这三行就是本轮修复要钉的：少一行，编辑写的文案就在下一次改价时静默消失
    expect(after?.['why']).toBe(why);
    expect(after?.['maker']).toBe('堺 打刃物工房');
    expect(after?.['tags']).toEqual(['堺打刃物', '碳钢']);
  });

  it('⚠️ 反证：PUT 不带三列 → 确实被清空（"省略即不改"在这三列上不成立）', async () => {
    const api = adminApi();
    const created = await createProduct(
      api,
      toProductInput({
        ...emptyProductForm(),
        title: 'Nakiri 菜切包丁',
        category: 'kitchen',
        priceJpy: '9800',
        weightG: '420',
        customsDescEn: 'kitchen knife, stainless steel',
        hsCode: '8211.91',
        editorialWhy: '薄刃，切丝不压伤纤维。',
      }),
    );
    const seen = (await listProducts(api)).items.find((p) => p.id === created.id);
    const body = toProductInput(productFormModel(seen), productFormModel(seen).stock);
    // 模拟"修复前的请求体"：三列直接不带（JSON.stringify 也会删掉 undefined）
    delete body['why'];
    delete body['maker'];
    delete body['tags'];
    await updateProduct(api, created.id, body, sourceUpdatedAt(seen));

    const after = (await listProducts(api)).items.find((p) => p.id === created.id);
    // ⚠️ 三列的"空"是**两种**形状，别写成一样的期望：
    //    - `why` / `maker` 是可空列（TEXT / VARCHAR），null 时 `toAdminProduct` **整键省略**
    //      ⇒ "没写"与"写了空串"在响应里可区分（前端据此显示"未填写"占位）；
    //    - `tags` 是 `JSONB NOT NULL DEFAULT '[]'`，**恒给数组**，空就是 `[]`
    //      ⇒ 不存在的第三种形态"标签字段缺失"在契约里没有意义。
    //    这条断言原本把两者都写成 undefined，跑出来 `[]`——期望值错了，语义没错。
    expect(after?.['why']).toBeUndefined();
    expect(after?.['maker']).toBeUndefined();
    expect(after?.['tags']).toEqual([]);
  });

  it('缺 expected_updated_at 的 PUT → 40001（不退化成无锁覆盖）', async () => {
    const api = adminApi();
    const created = await createProduct(
      api,
      toProductInput({
        ...emptyProductForm(),
        title: '无凭据商品',
        category: 'kitchen',
        priceJpy: '3000',
        weightG: '300',
        customsDescEn: 'pot',
        hsCode: '7323.93',
      }),
    );
    const err = await updateProduct(
      api,
      created.id,
      toProductInput({ ...productFormModel(created), title: '改个名' }),
      '',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(40001);
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
    // B41（AJ-215）：提示必须覆盖三种结果，且不得编造"幂等键"这种服务端没有的行为
    expect(g.reason).toContain('查询');
    expect(g.reason).toContain('不会重复退两次');
    expect(g.reason).not.toContain('同一幂等键');
    // 退款接口现在回传机构结果：mock 通道同步完成 → succeeded（不是拿不到就猜 pending）
    const outcome = await refundOrder(api, id, { reason: '再试一次' });
    expect(outcome).toBe('succeeded');
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
        hsCode: '6912.00',
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
