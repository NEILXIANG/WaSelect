/**
 * 职责：撤销管理员（离职处置，运维手册 §5）。CLI 入口在 `admin-revoke.ts`。
 *
 * @why 此前没有这条命令：手册只能写"重设口令 + 换手机密钥"的临时办法，离职的人账号仍是 is_admin=true，
 *      口令或密钥任一泄露就还能进后台。撤销 = 一次事务里同时做三件事：
 *      ① `is_admin = false`（登录口与 requireRole 回源都认它，AJ-442 / D25）；
 *      ② `token_ver + 1`（已签出的 token 下一次请求即失效，不等 12 小时）；
 *      ③ 清掉手机密钥（`totp_secret` / `totp_last_step`）——将来误恢复权限时旧手机上的码也不能用。
 * @why 最后一个"还能进后台的"管理员不能撤（`last_admin`）：撤掉之后谁都进不了后台，而恢复要直连改库。
 *      "还能进"= is_admin 且未被拉黑（拉黑的管理员登录口回 40301，不算数）。
 * @why 只走命令行、不给管理端界面：与 admin:password / admin:totp 同一道门槛（能连生产库的人）。
 * @why 先锁全部管理员行再数（`for update`）：两个终端同时撤两个人时，不会各自数到"还剩 2 个"而一起撤光。
 * @limitation 不删账号、不清口令哈希：审计与订单事件里的 actor 仍指向这个 id；他若同时是买家（有 openid），买家身份不受影响。
 * @limitation 只作废**服务进程之外**能作废的：服务进程里的身份缓存最长 60 秒后才看到 is_admin=false
 *             （与 admin:password 同一条，identity.ts @limitation）。
 * @see scripts/admin-totp-lib.ts（同一套审计写法）；docs/上线运维手册-首次部署·回滚·审核期切正式.md §5
 */
import { withTransaction, type Db } from '../server/src/adapters/db.js';
import { normalizeAdminEmail } from '../server/src/adapters/admin-auth.js';
import { createAdminAuditStore } from '../server/src/adapters/admin-audit.js';

export type RevokeAdminResult =
  { ok: true; userId: string } | { ok: false; reason: 'admin_not_found' | 'last_admin' };

export async function revokeAdmin(db: Db, email: string): Promise<RevokeAdminResult> {
  return withTransaction(db, async (tx) => {
    const admins = await tx`
      select id, lower(email) as email, blocked_at from users where is_admin = true for update`;
    const target = admins.find((a) => a['email'] === normalizeAdminEmail(email));
    if (target === undefined) return { ok: false, reason: 'admin_not_found' } as const;
    const usable = admins.filter((a) => a['blocked_at'] === null && a['id'] !== target['id']);
    if (usable.length === 0) return { ok: false, reason: 'last_admin' } as const;
    const userId = String(target['id']);
    await tx`
      update users set is_admin = false, token_ver = token_ver + 1,
                       totp_secret = null, totp_last_step = null
       where id = ${userId}`;
    await createAdminAuditStore(tx).append({
      actor: 'cli:admin-revoke',
      action: 'CLI admin.revoke',
      target: userId,
      before: { is_admin: true },
      after: { is_admin: false },
      statusCode: null,
      traceId: null,
      reqId: null,
    });
    return { ok: true, userId } as const;
  });
}
