/**
 * 职责：短链落地的**判定核心**（I1-U6a-2 / D-49）——`GET /pay/link/{id}?t=…` 应该
 *      302 到机构托管页，还是 302 到失效页，全部决定在这里；路由只是搬运 Location。
 *
 * @why 所有失败**同构为「失效」**（40202 语义，对外不区分原因）：
 *      订单不存在 / token 错 / 状态不对 / 到点未扫 / 无在途支付，对用户都是同一个
 *      「链接失效」页——区分原因等于告诉探测者"这单存在但 token 不对"，
 *      存在性探测与暴力枚举的分界线就在这里。原因只进内部日志（reason 字段）。
 *
 * @why token 只跟 **hash** 比：库里只有 sha256（pay-intent.ts 的 issuePayLink），
 *      明文永不落库——所以这里拿不到"正确的 token"来比对，只能重算 hash 对 hash。
 *      这也意味着**轮换后旧链接必然死**（旧 token 的 hash 对不上覆盖写后的新 hash），
 *      不需要额外的失效名单。
 *
 * @limitation 一：判定是**读时判定**，不加锁。用户在结果返回的同一毫秒被取消/落账，
 *              会跳到一个机构侧已作废的会话——机构页自己会显示"已过期/已支付"，
 *              伤害止步于体验，不为这一毫秒上 FOR UPDATE。
 * @limitation 二：timingSafeEqual 防的是"逐字节探测 hash"的时序侧信道；
 *              实际上攻击者拿不到 hash 输出（它在库里），这条防线是**纵深**性质，
 *              不是主要防线——主要防线是 token 的 128 bit 熵与 IP 限流。
 *
 * @see adapters/orders.ts findPayLinkTarget（读取）；app/pay-intent.ts issuePayLink
 *      （写入端，同一 token 约定的两端）；contracts/api-contract.yaml /pay/link/{id}
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../adapters/db.js';
import { findPayLinkTarget } from '../adapters/orders.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../logger.js';

/** 判定结果：跳转目标 URL，或失效（reason 仅供内部日志，不外发）。 */
export type PayLinkOutcome =
  { type: 'redirect'; url: string } | { type: 'expired'; reason: string };

/** issuePayLink 的 token 形状：两个 uuid 去横线 = 64 个小写 hex。 */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * token ↔ 库存 hash 的恒定时间比较。
 * @why 先重算 digest 再比，而不是 hex 字符串直接 `===`：字符串比较逐字符短路，
 *      耗时泄露"前多少位正确"。⚠️ `Buffer.from(坏 hex, 'hex')` 会**静默截断**，
 *      长度校验必须在 timingSafeEqual 之前（不等长它本身就抛）。
 */
function tokenMatchesHash(token: string, storedHash: string): boolean {
  const stored = Buffer.from(storedHash, 'hex');
  const digest = createHash('sha256').update(token).digest();
  if (stored.length !== digest.length) return false;
  return timingSafeEqual(stored, digest);
}

/**
 * 短链判定。永不抛业务错——所有"不行"都归一为 `{ type: 'expired' }`（文件头 @why）。
 * 日志只记 order_id 与 reason：**绝不记 token，也不记 pay_url**
 * （两者都是"拿到即能花"的钥匙，ADR-29 脱敏红线的适用处）。
 */
export async function resolvePayLink(
  db: Db,
  deps: { clock: Clock; logger: Logger },
  input: { orderId: string; token: string },
): Promise<PayLinkOutcome> {
  const fail = (reason: string): PayLinkOutcome => {
    deps.logger.info('pay_link_resolved', {
      order_id: input.orderId,
      result: 'expired',
      ctx: { reason },
    });
    return { type: 'expired', reason };
  };

  if (!TOKEN_PATTERN.test(input.token)) return fail('token_malformed');

  const row = await findPayLinkTarget(db, input.orderId);
  if (row === null) return fail('order_not_found');
  if (row.pay_token_hash === null || !tokenMatchesHash(input.token, row.pay_token_hash)) {
    // token 轮换后旧链接就死在这里（覆盖写后旧 hash 对不上）
    return fail('token_mismatch');
  }
  if (row.status !== 'pending_payment') return fail(`status_${row.status}`);
  // 「到点未扫」：关单 job 还没扫到，但支付窗口已闭（与关单/mark-paid/pay-intent 同一比较方向）
  if (deps.clock.now() >= row.expires_at) return fail('window_closed');
  if (row.pay_url === null) return fail('no_initiated_payment');

  deps.logger.info('pay_link_resolved', { order_id: input.orderId, result: 'redirect' });
  return { type: 'redirect', url: row.pay_url };
}
