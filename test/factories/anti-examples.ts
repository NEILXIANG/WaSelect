/**
 * 职责：反例库（F9-e）——"真实世界里会出现、但必须被库拒"的输入集合。
 *
 * 边界：本文件只收**商品**与**回调**两类的反例。**地址反例不在此**——
 *      它在 `catalog.ts` 的 `US_ADDRESS_INVALID`，且已被 `addresses.db.test.ts`（FX5）逐条消费，
 *      在这里重建一份就是第二处真源（改约束时两份必然漂移）。
 *
 * @why 每条反例必须带 `name` / `why` / `expect` 三件套：红灯时先回答"是哪一类、真实世界里怎么来的、
 *      预期撞哪条约束"。没有 `why` 的反例会退化成"随手写的坏数据"——改约束时没人敢动它，
 *      也不知道它还在不在保护当初想保护的东西。
 *
 * @why 反例**必须在真库里触发**（`trigger` 直接 INSERT）：断言"这个字符串不合法"是在重复
 *      zod/schema，不是验证约束。DDL 的 CHECK / 唯一约束 / 列宽是唯一不会说谎的裁判
 *      （与 entities.ts"插进真库当裁判"同源）。触发后还要断言"没写进去"（见 db 测试）。
 *
 * @limitation **不造订单反例**：订单的合法基线（`fx_snapshot` / `address_snapshot` 的结构、
 *              金额勾稽）属业务期，现在造就要猜规则。超额订单（qty > stock、负金额）随 I1 建单侧一起补。
 * @limitation `expect` 匹配的是**约束名或 SQLSTATE**（postgres.js 把约束名放进 `message`、
 *              SQLSTATE 放在 `.code`）——见 anti-examples.db.test.ts 的 expectRejected。
 *              它不校验"错误的语义是否友好"（那是 API 层的错误码映射，属 F4 业务侧）。
 *
 * @see migrations/001_init.sql（products 约束来源）；003_idempotency_and_identity.sql（webhook_events）；
 *      catalog.ts `US_ADDRESS_INVALID`（地址反例，唯一存放点）
 */
import { makeProduct } from './entities.js';
import { insertProductRow } from './seed-bundle.js';
import type { Rng } from './rng.js';
import type { Db } from '../../server/src/adapters/db.js';

/** 一条能在真库里触发的反例。 */
export interface DbAntiCase {
  /** 反例名，红灯时直接指出是哪一类。 */
  name: string;
  /** 真实世界里为什么会出现这种输入。 */
  why: string;
  /** 期望命中的约束名（PG 自动生成 `<table>_<col>_check`）或 SQLSTATE（如 22001 超长）。 */
  expect: string;
  /** 在真库里触发；**返回的 Promise 必须被库拒绝**（resolve 了就是约束漏了）。 */
  trigger: (db: Db, nextId: () => string, rng: Rng) => Promise<unknown>;
}

/** 商品类反例：每条都在一个**其余字段合法**的商品上只改坏一处。INSERT 复用 seed-bundle 的唯一实现。 */
export const ANTI_PRODUCTS: readonly DbAntiCase[] = [
  {
    name: '零售价为 0',
    why: '后台录价漏填会被前端默认值顶成 0；¥0 会被读成"免费"，是价格最贵的失败形态',
    expect: 'products_price_jpy_check',
    trigger: (db, nextId, rng) => insertProductRow(db, makeProduct(rng, nextId, { price_jpy: 0 })),
  },
  {
    name: '重量为 0',
    why: '重量漏填顶成 0 → 运费取档落进最轻档，重货按轻货运费卖（D-46 同族失真）',
    expect: 'products_weight_g_check',
    trigger: (db, nextId, rng) => insertProductRow(db, makeProduct(rng, nextId, { weight_g: 0 })),
  },
  {
    name: '库存为 -1',
    why: '手动调库存时把"扣 5"写成"= -1"；负库存会让超卖从"边界情况"变成"常态"',
    expect: 'products_stock_check',
    trigger: (db, nextId, rng) => insertProductRow(db, makeProduct(rng, nextId, { stock: -1 })),
  },
  {
    name: '原产国写成 CN',
    why:
      '⚠️ `makeProduct` 的注释声称 origin_country「不提供覆盖入口」，但 `Partial<ProductRow>` ' +
      '其实**能覆盖**——这条反例正是钻这个口子：D-43 要求 MVP 只卖日产，' +
      '撞的必须是 DB 级 `products_origin_jp`，不能停在应用层注释',
    expect: 'products_origin_jp',
    trigger: (db, nextId, rng) =>
      insertProductRow(db, makeProduct(rng, nextId, { origin_country: 'CN' })),
  },
];

/** 回调类反例：留痕表的幂等与列宽红线。 */
export const ANTI_WEBHOOKS: readonly DbAntiCase[] = [
  {
    name: '同一 (provider, event_id) 重复到达',
    why:
      'Stripe / 微信机构在网络抖动时会重投同一事件；`UNIQUE (provider, event_id)` ' +
      '是去重的最后一道（应用层幂等在它之前，但"依赖应用层"等于把重投窗口交给竞态）',
    expect: 'webhook_events_provider_event_id_key',
    trigger: async (db) => {
      // 固定 eventId：测试库每轮都被 resetTestDb 清空，不需要时间戳；
      // 用时间戳反而会让"这条反例撞的是唯一约束还是别的"变得不可复现。
      const eventId = 'evt_dup_fixture_0001';
      // 第一次必须成功（基线），第二次必须被唯一约束拒
      await db`insert into webhook_events (provider, event_id) values ('stripe', ${eventId})`;
      return db`insert into webhook_events (provider, event_id) values ('stripe', ${eventId})`;
    },
  },
  {
    name: 'event_id 超过 128 字符',
    why:
      '⚠️ 真实踩过（§2 第 20 条）：把 hex 摘要再 hex 一次得到 128 字符，' +
      '加 `sha256:` 前缀就是 135——插入即 22001，而桩存储不校验长度、单测全绿',
    expect: '22001',
    trigger: (db) => {
      const longId = `sha256:${'a'.repeat(128)}`;
      return db`insert into webhook_events (provider, event_id) values ('stripe', ${longId})`;
    },
  },
];
