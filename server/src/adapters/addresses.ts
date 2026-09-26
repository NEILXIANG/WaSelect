/**
 * 职责：`addresses` 表的 SQL 仓储（I1-U5a）——我的地址 CRUD，含"默认地址唯一"的换默认语义。
 *
 * @why 归属过滤一律进 WHERE（`and user_id = $u`）而不是查出再比对：
 *      地址 CRUD 的调用方只可能是本人，"查出别人的再判 404"除了多一个分支没有任何收益
 *      （与 readOwnedOrder 不同——那里要区分"不存在"与"非本人"两种日志成因，这里不需要）。
 *      响应统一 40400（防存在性探测，与订单同口径）。
 *
 * @why 换默认 = 事务内两句（先清后设），**不能**用单句 `set is_default = (id = $1)`：
 *      PG 的唯一索引是逐行即时检查的，单句同时"置 B true、置 A false"的执行顺序不定，
 *      先置 B true 的那一刻就撞 011 的部分唯一索引（经典 swap 问题）。
 *      先清后设在事务内串行执行，任何时刻库里最多一条默认。
 *      011 索引与这里的两句互为纵深：索引兜并发，两句兜逻辑。
 *
 * @limitation 一：把当前默认地址"取消默认"（is_default=false 更新）后，用户可以处于
 *              **无默认地址**状态——契约不禁止，前端要处理"没有默认"的展示。
 * @limitation 二：删除默认地址**不**自动提升其它地址为默认（哪条该升？这是个没有
 *              正确答案的业务问题，静默挑一条比"没有默认"更容易出错）。
 *
 * @see migrations/001_init.sql（addresses 表与 CHECK）、011（默认唯一部分索引）；
 *      app/address-routes.ts（调用方）；docs/I1阶段开发实施方案.md §3.5
 */
import { withTransaction, type Db } from './db.js';

/** 地址输入（已通过路由层 40001/40002 校验）。 */
export interface AddressInput {
  recipient: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  is_default: boolean;
}

export interface AddressRow extends AddressInput {
  id: string;
}

/** postgres.js 行 → AddressRow（列与 001 的 addresses 表逐项对应）。 */
function toRow(r: Record<string, unknown>): AddressRow {
  return {
    id: String(r['id']),
    recipient: String(r['recipient']),
    phone: String(r['phone']),
    line1: String(r['line1']),
    line2: r['line2'] === null ? null : String(r['line2']),
    city: String(r['city']),
    state: String(r['state']),
    postal_code: String(r['postal_code']),
    country: String(r['country']),
    is_default: Boolean(r['is_default']),
  };
}

export interface AddressRepo {
  /** 我的地址列表（默认在前，其余按创建先后）。 */
  listByUser(userId: string): Promise<AddressRow[]>;
  /** 新增（is_default=true 时同事务清掉旧默认）。 */
  create(id: string, userId: string, input: AddressInput): Promise<AddressRow>;
  /** 全量更新（PUT 语义）；不存在或非本人 → false。 */
  update(id: string, userId: string, input: AddressInput): Promise<AddressRow | null>;
  /** 删除；不存在或非本人 → false（不自动提升新默认，见 @limitation 二）。 */
  remove(id: string, userId: string): Promise<boolean>;
}

// ⚠️ 列清单在三个查询里**各手写一遍**而不是抽常量拼接——抽常量就得用 `db.unsafe()` 或
//    标识符拼接（`db(COLUMNS)` 会把整串当成**一个**列名加引号），两者都比手写危险。
//    漏列不会静默：toRow 取到 undefined 会产出 "undefined" 字符串，真库用例当场红
//    （与 country-profiles.ts @why 同口径）。
export function createAddressRepo(db: Db): AddressRepo {
  return {
    async listByUser(userId: string): Promise<AddressRow[]> {
      const rows = await db`
        select id, recipient, phone, line1, line2, city, state, postal_code, country, is_default
          from addresses
         where user_id = ${userId}
         order by is_default desc, created_at asc, id
      `;
      return rows.map((r) => toRow(r as Record<string, unknown>));
    },

    async create(id: string, userId: string, input: AddressInput): Promise<AddressRow> {
      return withTransaction(db, async (tx) => {
        if (input.is_default) {
          await tx`update addresses set is_default = false where user_id = ${userId} and is_default`;
        }
        await tx`
          insert into addresses (id, user_id, recipient, phone, line1, line2, city, state,
                                 postal_code, country, is_default)
          values (${id}, ${userId}, ${input.recipient}, ${input.phone}, ${input.line1},
                  ${input.line2}, ${input.city}, ${input.state}, ${input.postal_code},
                  ${input.country}, ${input.is_default})
        `;
        return { id, ...input };
      });
    },

    async update(id: string, userId: string, input: AddressInput): Promise<AddressRow | null> {
      return withTransaction(db, async (tx) => {
        if (input.is_default) {
          // 先清后设（文件头 @why 的 swap 问题）；把自己也一起清，下一步再设回来，语义不变
          await tx`update addresses set is_default = false where user_id = ${userId} and is_default`;
        }
        const rows = await tx`
          update addresses
             set recipient = ${input.recipient}, phone = ${input.phone}, line1 = ${input.line1},
                 line2 = ${input.line2}, city = ${input.city}, state = ${input.state},
                 postal_code = ${input.postal_code}, country = ${input.country},
                 is_default = ${input.is_default}
           where id = ${id} and user_id = ${userId}
           returning id, recipient, phone, line1, line2, city, state, postal_code, country, is_default
        `;
        const r = rows[0];
        return r === undefined ? null : toRow(r as Record<string, unknown>);
      });
    },

    async remove(id: string, userId: string): Promise<boolean> {
      const rows = await db`
        delete from addresses where id = ${id} and user_id = ${userId}
      `;
      return rows.count > 0;
    },
  };
}
