/**
 * 职责：风控的读写仓储（I2 U-E2）——拒付列表与拉黑。
 *
 * @why `blocked_at` 与 `token_ver` 由 **SQL 侧**决定取什么值，不由调用方传：
 *      "什么时候封的"必须是库里的时间（传进来的值可能是任何一个实例的时钟，F10）；
 *      `token_ver + 1` 则是 D25 定下的口径（`adapters/identity.ts` 抬头：改密 / 封禁时 +1）——
 *      不加的话旧 token 在有效期内仍然能通过 `requireRole`。
 *
 * @why 拉黑先 `select is_admin` 再 update，而不是一条 `where id = ? and is_admin = false`：
 *      后者在 0 行命中时**分不出**"人不存在"与"对方是管理员"，只能给一个含糊的错误；
 *      而这两件事对运营的处置完全不同（前者是"刷新列表"，后者是"先把对方降为普通账号"）。
 *      ⚠️ 判据：**凡是 0 行命中同时可能是两种原因的写操作，都必须先分辨再给码**。
 *
 * @limitation 一：拒付列表**只按时间倒序**，不排"进行中优先"——
 *              "进行中排最前"是**前端**的排序规则（`admin-web/src/risk/view.ts`）。
 *              两处排同一个序会各自漂移（同一处"两层都判"的风险，见 aj）；这里只负责
 *              "新的在前"这一个与前端不重叠的维度。
 * @limitation 二：列表**不分页**（与 `ops-config.listFxRates` 同口径）。
 *              拒付的量级是"每天个位数"，分页会把"一眼看完全部"变成"翻页才能发现有一条是要命的"。
 * @limitation 三：`blockUser` 是**幂等**的：已拉黑的账号再次调用返回 `already`，
 *              **不刷新 `blocked_at`、不再 +1 `token_ver`**——
 *              否则"重复点一次拉黑"会把首次封禁时间改掉（审计时答不出"什么时候封的"），
 *              并且把所有人重新登一遍。
 * @limitation 四：`identity.ts` 的身份查询有 60 秒进程内缓存——拉黑路由成功后会作废**本进程**的这一条
 *              （F-06 / AJ-183），单实例部署下即时生效；多实例时其它实例仍各有 60 秒窗口
 *              （render.yaml 固定单实例并有断言钉住；扩容前要换成共享失效机制）。
 *
 * @see migrations/001_init.sql（payments.dispute_* / users.blocked_at）、003（users.token_ver）、
 *      013（payments.dispute_opened_at）；domain/dispute-input.ts（status 校验）；
 *      app/admin-risk-routes.ts（唯一调用方）
 */
import type { Db } from './db.js';
import type { DisputeStatus } from '../domain/dispute-input.js';

/** 拒付列表一行（契约 `Dispute`）。金额是**原币**，不是 JPY。 */
export interface DisputeRow {
  paymentId: string;
  orderId: string;
  orderNo: string;
  disputeId: string;
  /** 库里是 VARCHAR(16)，未落状态时为 null（契约 enum 之外的取值按 null 处理，见 @limitation 五）。 */
  disputeStatus: DisputeStatus | null;
  disputeAmount: number | null;
  chargeCurrency: string;
  openedAt: Date | null;
  closedAt: Date | null;
}

/** 拉黑结果（判别联合：调用方必须穷举，漏一种编译不过）。 */
export type BlockOutcome =
  { kind: 'blocked'; already: boolean } | { kind: 'not_found' } | { kind: 'is_admin' };

export interface RiskAdminRepo {
  /** 有拒付的支付行（@limitation 一/二）。 */
  listDisputes(status?: DisputeStatus): Promise<DisputeRow[]>;
  /** 拉黑（@limitation 三）；**拒绝拉黑管理员**（路由层转 40911）。 */
  blockUser(id: string): Promise<BlockOutcome>;
}

function toDisputeRow(r: Record<string, unknown>): DisputeRow {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const status = r['dispute_status'];
  return {
    paymentId: String(r['payment_id']),
    orderId: String(r['order_id']),
    orderNo: String(r['order_no']),
    disputeId: String(r['dispute_id']),
    disputeStatus: typeof status === 'string' ? (status as DisputeStatus) : null,
    disputeAmount: num(r['dispute_amount']),
    chargeCurrency: String(r['charge_currency'] ?? ''),
    openedAt: (r['dispute_opened_at'] as Date | null) ?? null,
    closedAt: (r['dispute_closed_at'] as Date | null) ?? null,
  };
}

const DISPUTE_COLS = `p.id as payment_id, p.order_id, o.order_no, p.dispute_id, p.dispute_status,
  p.dispute_amount, p.charge_currency, p.dispute_opened_at, p.dispute_closed_at`;

export function createRiskAdminRepo(db: Db): RiskAdminRepo {
  return {
    async listDisputes(status?: DisputeStatus): Promise<DisputeRow[]> {
      // 🔴 `dispute_id is not null` 是"这是一条拒付"的唯一判据——不能改用 `has_dispute`：
      //    orders.has_dispute 是订单层的冗余标记（会有超时/commit 顺序带来的短暂不一致），
      //    而列表要给的是"支付侧留下来的拒付记录"。两处判定会各自漂移。
      // ⚠️ 一条查询 + 条件参数，而不是"过滤/不过滤"各写一条 SQL：
      //    后者会让 `dispute_id is not null` 这个判据出现**两份**，
      //    改一处漏一处时表现为"筛某个状态时列表里混进了没有拒付的支付行"，
      //    而且只在筛状态下才看得见——正是最难被单测覆盖到的那一半
      //    （本次缺陷注入 ① 就栽在这里：注掉过滤分支的判据，用例全绿）。
      //    @tradeoff `(${status}::text is null or …)` 让这个条件无法走 `dispute_status` 的索引：
      //              拒付在 MVP 是个位数级，全表扫描的代价远小于"两条 SQL 各维护一份判据"。
      const rows = await db`
        select ${db.unsafe(DISPUTE_COLS)}
          from payments p join orders o on o.id = p.order_id
         where p.dispute_id is not null
           and (${status ?? null}::text is null or p.dispute_status = ${status ?? null})
         order by p.dispute_opened_at desc nulls last, p.created_at desc
      `;
      return rows.map((r) => toDisputeRow(r as Record<string, unknown>));
    },

    async blockUser(id: string): Promise<BlockOutcome> {
      const found = await db`select is_admin, blocked_at from users where id = ${id}`;
      const row = found[0];
      if (row === undefined) return { kind: 'not_found' };
      if (row['is_admin'] === true) return { kind: 'is_admin' };
      const already = row['blocked_at'] !== null && row['blocked_at'] !== undefined;
      const out = await db`
        update users
           set blocked_at = coalesce(blocked_at, now()),
               token_ver  = case when blocked_at is null then token_ver + 1 else token_ver end
         where id = ${id}
        returning id
      `;
      if (out.length === 0) return { kind: 'not_found' };
      return { kind: 'blocked', already };
    },
  };
}
