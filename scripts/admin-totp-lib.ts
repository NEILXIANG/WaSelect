/**
 * 职责：管理员 TOTP 第二因素的开通 / 关闭（P1-5 / AJ-386）。CLI 入口在 `admin-totp.ts`。
 *
 * @why 只走命令行、不给管理端界面：拿到 token 的人（含偷到 token 的人）不能自己关掉第二因素；
 *      能跑这个脚本的人必须能连上生产库，与改密（admin:password）同一道门槛。
 * @why 开通 / 关闭都 `token_ver + 1`：已签出的 token 全部失效。否则"发现可疑 → 开 TOTP"之后，
 *      攻击者手里那张 12 小时的 token 照样能退款。
 * @why 再次开通 = 换密钥并清 `totp_last_step`：手机丢了的恢复路径就是重新开通。
 * @limitation 密钥只在开通那一刻打印一次（终端回滚缓冲里会留着——操作完清屏）；库里明文存（迁移 033 @limitation）。
 * @see migrations/033_admin_totp.sql；server/src/adapters/totp.ts；server/src/app/admin-auth-routes.ts
 */
import type { Db } from '../server/src/adapters/db.js';
import { normalizeAdminEmail } from '../server/src/adapters/admin-auth.js';
import { createAdminAuditStore } from '../server/src/adapters/admin-audit.js';
import { generateTotpSecret, totpUri } from '../server/src/adapters/totp.js';

/** 验证器 App 里显示的发行方名。 */
const ISSUER = 'WaSelect Admin';

export type EnableTotpResult =
  | { ok: true; userId: string; secret: string; uri: string }
  | { ok: false; reason: 'admin_not_found' };

async function audit(db: Db, userId: string, action: string): Promise<void> {
  await createAdminAuditStore(db).append({
    actor: 'cli:admin-totp',
    action,
    target: userId,
    // ⚠️ 密钥绝不进审计表（append-only、无保留期）
    before: null,
    after: null,
    statusCode: null,
    traceId: null,
    reqId: null,
  });
}

export async function enableAdminTotp(db: Db, email: string): Promise<EnableTotpResult> {
  const secret = generateTotpSecret();
  const rows = await db`
    update users set totp_secret = ${secret}, totp_last_step = null, token_ver = token_ver + 1
     where lower(email) = ${normalizeAdminEmail(email)} and is_admin = true
    returning id, email`;
  const r = rows[0];
  if (r === undefined) return { ok: false, reason: 'admin_not_found' };
  const userId = String(r['id']);
  await audit(db, userId, 'CLI admin.totp.enable');
  return { ok: true, userId, secret, uri: totpUri(secret, String(r['email']), ISSUER) };
}

export async function disableAdminTotp(
  db: Db,
  email: string,
): Promise<{ ok: true } | { ok: false; reason: 'admin_not_found' }> {
  const rows = await db`
    update users set totp_secret = null, totp_last_step = null, token_ver = token_ver + 1
     where lower(email) = ${normalizeAdminEmail(email)} and is_admin = true
    returning id`;
  const r = rows[0];
  if (r === undefined) return { ok: false, reason: 'admin_not_found' };
  await audit(db, String(r['id']), 'CLI admin.totp.disable');
  return { ok: true };
}
