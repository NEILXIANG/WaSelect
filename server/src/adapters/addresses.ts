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
 * @limitation 三：`update` **先确认目标存在（带 `for update`）再动默认标记**（B23 / AJ-203）。
 *              反过来做的话，"更新一个已被删掉的地址并勾选默认"会**提交**那句清默认，
 *              于是用户拿到 404 的同时失去了默认地址——一个不报错、也不显示的损失。
 *
 * @see migrations/001_init.sql（addresses 表与 CHECK）、011（默认唯一部分索引）；
 *      app/address-routes.ts（调用方）；docs/I1阶段开发实施方案.md §3.5
 */
import { MAX_ADDRESSES_PER_USER } from '@waselect/shared';
import { AppError } from '../errors.js';
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
  /** 全量更新（PUT 语义）；不存在或非本人 → `null`（⚠️ 曾经写 "→ false"，与下面的 `remove` 混了）。 */
  update(id: string, userId: string, input: AddressInput): Promise<AddressRow | null>;
  /** 删除；不存在或非本人 → false（不自动提升新默认，见 @limitation 二）。 */
  remove(id: string, userId: string): Promise<boolean>;
}

// ⚠️ 列清单在三个查询里**各手写一遍**而不是抽常量拼接——抽常量就得用 `db.unsafe()` 或
//    标识符拼接（`db(COLUMNS)` 会把整串当成**一个**列名加引号），两者都比手写危险。
//    漏列不会静默：toRow 取到 undefined 会产出 "undefined" 字符串，真库用例当场红
//    （与 country-profiles.ts @why 同口径）。
/**
 * 把同一用户的"设默认"串行化（S-03）：先锁住该用户的 users 行。
 * @why READ COMMITTED 下两个并发的"清默认 → 写新默认"会互相看不见对方刚插入的默认行：
 *      后者在旧默认行的锁上等，前者提交后旧行已不是默认，后者跳过它、照常插入一条默认，
 *      撞上部分唯一索引 → 23505 → 500（而前一条其实已经保存了）。连点保存、网络重试都会触发。
 * @why 锁 users 行而不是地址行：新建时还没有地址行可锁；锁序"先 users 后其它"与建单、拉黑一致，不会成环。
 *      ⚠️ `update` 也必须先调它、再锁地址行（P1-2，2026-10-08 实测旧顺序 40P01）——任何新写路径同样守这个顺序。
 * @limitation 只在 is_default=true 时加锁：不设默认的写入不会撞这个索引，不必串行。
 */
async function lockUserDefaults(tx: Db, userId: string): Promise<void> {
  await tx`select id from users where id = ${userId} for update`;
}

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
        // 用户行锁**无条件**先取（AJ-384）：条数上限要在锁内数，否则并发两次新增都看见 19 条、都插进去。
        // 原先只在设默认时取这把锁；同一把锁，取得更早而已，锁序不变。
        await lockUserDefaults(tx, userId);
        const [cnt] = await tx`select count(*)::int as n from addresses where user_id = ${userId}`;
        if (Number(cnt?.['n'] ?? 0) >= MAX_ADDRESSES_PER_USER) {
          throw new AppError(40917, { reason: 'addresses_too_many', max: MAX_ADDRESSES_PER_USER });
        }
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
        // ⚠️ 锁序必须与 `create()` 一致：**先 users 行、后地址行**（S-03 / 死锁 P1-2）。
        //    旧实现是"地址行 for update → 再 lockUserDefaults（users 行）"，与 create（users → 地址）
        //    构成 AB/BA 锁序反转：并发"把 A 改成默认"（先锁地址行）与"新建并设默认"（先锁 users）
        //    时，若 A 正是要清掉的旧默认行，两事务互等 → 40P01 死锁 → 50000（非 AppError）。
        //    把 lockUserDefaults 提到最前，与 create 的锁序统一，成环不再可能。
        //    ⚠️ 只在 is_default=true 时加锁（与 lockUserDefaults 的 @limitation 同口径）：
        //       不设默认的写入不碰 users 锁、也不清默认，无需串行。
        if (input.is_default) {
          await lockUserDefaults(tx, userId);
        }
        // ⚠️ B23 / AJ-203：**先确认目标存在**，再动"默认"标记——顺序反了就是静默数据损坏。
        //    曾经先 `update … set is_default = false where user_id = …`（清掉所有默认），
        //    再更新目标行；目标不存在（另一个标签页刚删掉它）时更新 0 行 → 返回 null → 404，
        //    但**清默认那句已经提交**了：用户得到一个 404，同时他的默认地址被悄悄清掉。
        //    从用户视角是"保存失败"（他会再点一次），而真实损失（默认地址没了）不报错、不显示。
        //    @why 用 `for update` 而不是普通 select：确认与写入之间必须**没有窗口**——
        //        否则并发删除仍可插进来（那时损失小得多：更新 0 行、默认未被清，只是 404）。
        const target =
          await tx`select id from addresses where id = ${id} and user_id = ${userId} for update`;
        if (target.length === 0) return null;
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
