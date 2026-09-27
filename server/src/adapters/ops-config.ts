/**
 * 职责：运营配置的**唯一**读写仓储（I2 U-C2）——`fx_rates` 与 `shipping_rates` 两张配置表。
 *
 * @why 两张表此前**只有读者没有写者**（`catalog.ts` @limitation 二 明写"汇率刷新属
 *      daily job / 管理端，I1 范围外"）。写者落地在这里而不是塞进 `catalog.ts`：
 *      那份文件的 @why 与 @limitation 全部建立在"只读"之上（"运费取档 SQL 全仓库只此一份"
 *      的论证就依赖它不掺杂写路径）。掺进去的话每条注释都要重新论证一遍，
 *      而重新论证从来没人做——于是注释与事实分离（ADR-29：分离即 bug）。
 *      与 `catalog.ts`（只读）/ `catalog-admin.ts`（商品写）三分的口径一致。
 *
 * @why 🔴 `replaceShippingRates` 必须**在事务里**做 `delete` + 批量 `insert`：
 *      整表替换一旦中途失败（DB 约束/类型溢出），留下的不是"没保存"而是**半张表甚至空表**——
 *      空表的后果是 `resolveSingleActiveCarrier()` 返回 null → **全站 50004 无法报价**。
 *      这不是"数据不一致"，是"全站停业"，所以它必须原子。
 *
 * @why 本文件**不提供任何取档 SQL**：运费取档全仓库只允许 `catalog.ts` 那一份（D-46 红线）。
 *      本文件的测试用 `catalog.findShippingPriceJpy` 做交叉验证，正是为了强化这条红线——
 *      自己写一条"数行数"的 SQL 去断言，验证不了"取档方向还正确吗"。
 *
 * @limitation 一：`listFxRates` 返回**全部行**（含历史与未来生效的），不按"当前生效"过滤。
 *              理由见路由层 AJ-149：过滤掉未来行会让"刚提交的未来汇率"在列表里消失，
 *              运营会以为没保存成功。排序 `quote asc, effective_from desc`，
 *              每个币种最新的一行排在最上面。
 * @limitation 二：`insertFxRate` **不 upsert**：`UNIQUE(quote, effective_from)` 冲突直接抛，
 *              由路由层转成错误码。不做"同秒覆盖"是因为覆盖会静默抹掉前一条维护记录——
 *              而汇率维护是"谁在什么时候改成了多少"这种需要留痕的事。
 *              ⚠️ 代价：同一秒内提交两次会得到 500（而不是幂等成功），MVP 可接受。
 * @limitation 三：`shipping_rates` 的 `id` 是 `SERIAL`，整表替换后 id 会重新计数前移
 *              （`resetTestDb` 的 `restart identity` 同因）。没有外部引用依赖这个 id
 *              （orders 里存的是 `shipping_jpy` 数字快照），所以无影响。
 *
 * @see migrations/001_init.sql（fx_rates / shipping_rates 两条 UNIQUE）；
 *      domain/fx-input.ts、domain/shipping-rates-input.ts（输入校验，写之前已过）；
 *      app/admin-ops-routes.ts（唯一调用方）
 */
import type { Db } from './db.js';
import { withTransaction } from './db.js';
import type { ShippingRateInput } from '../domain/shipping-rates-input.js';

/** 汇率行（与契约 `FxRate` 逐字段同形；NUMERIC 已转成 number）。 */
export interface FxRateRow {
  quote: string;
  rate: number;
  raw_rate: number;
  buffer: number;
  effective_from: Date;
}

/** 写入形状。 */
export interface FxRateInsert {
  quote: string;
  /** 已含缓冲的展示汇率（`applyFxBuffer` 的产物），**不是** raw_rate。 */
  rate: number;
  rawRate: number;
  buffer: number;
  /** UTC 毫秒（domain 侧产出，见 fx-input.ts 的 F10 说明）。 */
  effectiveFromMs: number;
  createdBy: string | null;
}

/** 运费分档行（与契约 `ShippingRate` 逐字段同形）。 */
export interface ShippingRateRow {
  carrier: string;
  max_weight_g: number;
  price_jpy: number;
  active: boolean;
}

export interface OpsConfigRepo {
  /** 全部汇率行（含历史与未来）；排序见 @limitation 一。 */
  listFxRates(): Promise<FxRateRow[]>;
  /** 插入一行汇率；UNIQUE 冲突直接抛（@limitation 二）。 */
  insertFxRate(row: FxRateInsert): Promise<FxRateRow>;
  /** 该币种**已生效**的最新一行（`effective_from <= now`）；无 → null。 */
  findLatestFxRate(quote: string, now: Date): Promise<FxRateRow | null>;
  /** 全部档位（含停用）；carrier 升序、同承运商内上限升序。 */
  listShippingRates(): Promise<ShippingRateRow[]>;
  /** 🔴 事务内整表替换（@why）；返回替换后的整表。 */
  replaceShippingRates(rows: readonly ShippingRateInput[]): Promise<ShippingRateRow[]>;
}

/** 取全部汇率行（事务内外共用：replaceShippingRates 要在同一事务里读回结果）。 */
async function selectFxRates(tx: Db, where: readonly unknown[] = []): Promise<FxRateRow[]> {
  const rows = await tx`
    select quote, rate, raw_rate, buffer, effective_from
      from fx_rates
      ${where.length > 0 ? tx`where quote = ${where[0] as string} and effective_from <= ${where[1] as Date}` : tx``}
     order by quote asc, effective_from desc
     ${where.length > 0 ? tx`limit 1` : tx``}
  `;
  return rows.map(toFxRateRow);
}

function toFxRateRow(r: Record<string, unknown>): FxRateRow {
  return {
    quote: String(r['quote']).trim(),
    rate: Number(r['rate']),
    raw_rate: Number(r['raw_rate']),
    buffer: Number(r['buffer']),
    effective_from: r['effective_from'] as Date,
  };
}

async function selectShippingRates(tx: Db): Promise<ShippingRateRow[]> {
  const rows = await tx`
    select carrier, max_weight_g, price_jpy, active
      from shipping_rates
     order by carrier asc, max_weight_g asc
  `;
  return rows.map((r) => ({
    carrier: String(r['carrier']),
    max_weight_g: Number(r['max_weight_g']),
    price_jpy: Number(r['price_jpy']),
    active: Boolean(r['active']),
  }));
}

export function createOpsConfigRepo(db: Db): OpsConfigRepo {
  return {
    listFxRates: () => selectFxRates(db),

    async insertFxRate(row: FxRateInsert): Promise<FxRateRow> {
      const at = new Date(row.effectiveFromMs);
      const out = await db`
        insert into fx_rates (quote, rate, raw_rate, buffer, effective_from, created_by)
        values (${row.quote}, ${row.rate}, ${row.rawRate}, ${row.buffer}, ${at}, ${row.createdBy})
        returning quote, rate, raw_rate, buffer, effective_from
      `;
      const r = out[0];
      if (r === undefined) throw new Error('fx_rates 插入未返回行');
      return toFxRateRow(r as Record<string, unknown>);
    },

    async findLatestFxRate(quote: string, now: Date): Promise<FxRateRow | null> {
      const rows = await selectFxRates(db, [quote, now]);
      return rows[0] ?? null;
    },

    listShippingRates: () => selectShippingRates(db),

    async replaceShippingRates(rows: readonly ShippingRateInput[]): Promise<ShippingRateRow[]> {
      return withTransaction(db, async (tx) => {
        await tx`delete from shipping_rates`;
        // ⚠️ 逐条插入而不是批量 `values ${tx([[…]])}`：postgres.js 的多行 helper 类型
        //    （`EscapableArray`）只接受 string/number/Date，**不含 boolean**，
        //    用 `as` 断言绕过去等于把类型层的保护丢掉。运费表档位个位数，
        //    逐条插入多出的往返成本可忽略——为省几次往返去绕过类型不划算。
        //    （空表由 domain 挡住，这里不做额外分支。）
        for (const r of rows) {
          await tx`
            insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
            values (${r.carrier}, ${r.maxWeightG}, ${r.priceJpy}, ${r.active})
          `;
        }
        return selectShippingRates(tx);
      });
    },
  };
}
