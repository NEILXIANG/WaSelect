/**
 * 职责：`payment_channels` **接线是否真的生效**的端到端用例（R2-4 / AJ-379）。
 *
 * @why 这是整条接线唯一无法用单测替代的一段证明：
 *      ① 内置常量与表的 seed **逐字相同**（同源比对钉住），所以"读表"与"没读表"
 *         在 seed 状态下**行为完全一致**——改表数据之前，没有任何一条用例能区分两者；
 *      ② 于是"表 → 装配 → `GET /pay/channels`"必须有一条**真库 + 真路由**的用例，
 *         否则"接线完成"这句话永远只是注释里的一句。
 *      本文件做的事只有一件：**改库里一行，看 HTTP 响应变不变**。
 *
 * @limitation 一：改数据要**重建进程**才生效（属性在装配期读一次，
 *              `payment-channel-config.ts` @limitation 二）。用例里用"重建 server"
 *              模拟重启——这既是限制，也是这条口径的**可执行说明**。
 * @limitation 二：⚠️ 本文件**写配置表**（配置表不被 `resetTestDb` 清，写会污染别的文件）。
 *              所以每个用例都在 `finally` 里把那一行**还原**，并额外断言还原成功——
 *              "靠被测行为失败来顺带清理"是循环论证（见 payment-channels-seed.db.test.ts
 *              同一条的 @limitation），这里不靠它。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../adapters/db.js';
import { closeDb } from '../adapters/db.js';
import { loadChannelConfigs } from '../adapters/payment-channel-config.js';
import { ensureTestDb, testDb } from '../../../test/db/test-db.js';
import { buildChainServer, call, type ChainServer } from '../../../test/helpers/chain-server.js';

let db: Db;
let srv: ChainServer;

/** stripe 与 mock 都装配得起来（stripe 三要素齐）。 */
const ENV = {
  PAYMENT_CHANNELS: 'mock,stripe',
  STRIPE_SECRET_KEY: 'sk_test_1',
  STRIPE_WEBHOOK_SECRET: 'whsec_1',
  CHECKOUT_BASE_URL: 'https://checkout.waselect.jp',
} as const;

/** JPY 市场：seed 下只有 mock 声明了 JPY（stripe 只声明 USD）。 */
const JPY = '/api/v1/pay/channels?country=US&currency=JPY&amount_jpy=10000';

async function channelsForJpy(): Promise<string[]> {
  const r = await call(srv, 'GET', JPY);
  expect(r.status).toBe(200);
  const rows = r.json['items'] as Array<{ channel: string }>;
  return rows.map((x) => x.channel);
}

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

afterEach(async () => {
  await srv.close();
});

describe('payment_channels 表 → GET /pay/channels（接线生效的硬证据）', () => {
  it('seed 状态下 JPY 市场只有 mock（stripe 只声明 USD）——这是"改之前"的基准', async () => {
    srv = await buildChainServer(db, { ...ENV });
    expect(await channelsForJpy()).toEqual(['mock']);
  });

  /**
   * @why 核心用例：把 stripe 的 `currencies` 改成 `["*"]`、`priority` 改成 1（排到 mock 前面），
   *      重建进程后同一个查询从 `['mock']` 变成 `['stripe','mock']`。
   *      **同一个配置、同一份代码，唯一变化的是库里那一行**——这就是"改数据不改代码"。
   */
  it('改库里一行（stripe 改成 * 币种 + 排最前）→ 重建后 stripe 出现在 JPY 市场且排在首位', async () => {
    const [before] = await db<
      { priority: number; currencies: unknown }[]
    >`select priority, currencies from payment_channels where channel = 'stripe'`;
    expect(before, '表里必须有 stripe 这一行（seed）').toBeDefined();

    try {
      await db`
        update payment_channels
           set currencies = '["*"]'::jsonb, priority = 1
         where channel = 'stripe'
      `;
      // ⚠️ 必须重建：属性在装配期读一次（@limitation 一），这一步就是"重启"
      srv = await buildChainServer(db, { ...ENV });
      expect(await channelsForJpy()).toEqual(['stripe', 'mock']);

      // 顺带钉住"读取口读到的就是改后的值"——否则上面那条红的是别的原因
      const rows = await loadChannelConfigs(db);
      const stripe = rows.find((r) => r.channel === 'stripe');
      expect(stripe?.currencies).toEqual(['*']);
      expect(stripe?.priority).toBe(1);
    } finally {
      /**
       * ⚠️ JSONB 必须走 `db.json()`：`${字符串}::jsonb` 会被驱动**再 JSON 编码一次**
       *    （§2 第 78 条：列里存的是字符串标量，`jsonb_typeof` 变成 'string'，
       *    于是 CHECK 直接拒——而它看起来像"数据写错了"，不像"写法错了"）。
       */
      await db`
        update payment_channels
           set currencies = ${db.json((before?.currencies ?? []) as string[])}::jsonb,
               priority = ${before?.priority ?? 20}
         where channel = 'stripe'
      `;
    }

    // 还原断言（@limitation 二）：配置表不被清，残留会污染别的文件
    const [after] = await db<
      { priority: number }[]
    >`select priority from payment_channels where channel = 'stripe'`;
    expect(after?.priority).toBe(before?.priority);
  });

  /**
   * @why 装配期的属性来源会打进启动日志 `attrs_source`：接线之后它必须是 `table`。
   *      这一条盯的是"表**有没有被读进来**"——上一个用例盯的是"读进来之后**有没有被用**"。
   *      两者缺一都可能只剩一半接线（读了没用 / 用了但读的是常量），而行为看起来都正常。
   */
  it('启动日志的 attrs_source 如实写 table（表被读进装配）', async () => {
    srv = await buildChainServer(db, { ...ENV });
    const line = srv.sink.find('payment_channels_registered')[0];
    const ctx = (line?.['ctx'] ?? {}) as { attrs_source?: Record<string, string> };
    expect(ctx.attrs_source?.['mock']).toBe('table');
    expect(ctx.attrs_source?.['stripe']).toBe('table');
  });
});
