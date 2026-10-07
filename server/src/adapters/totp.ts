/**
 * 职责：TOTP（RFC 6238：HMAC-SHA1、30 秒一步、6 位）——管理端登录的第二因素（第三轮缺口 P1-5，AJ-386）。
 *
 * @why 自己实现而不引库：算法是 RFC 4226 的 20 行（HMAC + 动态截断），引一个依赖换不来什么，
 *      却多一个供应链入口（管理端登录正是最该少依赖的地方）。正确性由 RFC 6238 附录 B 的官方向量钉住。
 * @why SHA-1 / 6 位 / 30 秒：Google Authenticator、1Password、Authy 等全部默认支持的唯一组合；
 *      换 SHA-256 或 8 位，部分 App 会静默按默认值算，表现为"码永远不对"。
 * @why 住在 adapters：要 `node:crypto`（domain 层零依赖）。
 * @limitation 只做算法：防重放（同一步只能用一次）靠调用方把命中的步数写进 `users.totp_last_step`
 *             （admin-auth.ts `consumeTotpStep`）。
 * @see server/src/app/admin-auth-routes.ts（登录时校验）；scripts/admin-totp.ts（开通）
 */
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;
const DIGITS = 6;
/** 允许的时钟漂移：前后各一步（±30 秒），RFC 6238 §5.2 的推荐值。 */
const DRIFT_STEPS = 1;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 容忍小写、空格、`=` 填充；其余字符抛错（不静默跳过——那会把密钥悄悄截短）。 */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`base32 非法字符：${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function codeForStep(key: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  // 步数可超 32 位（t=20000000000 时约 6.7 亿，仍在 2^53 内）：高低位分开写
  msg.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  msg.writeUInt32BE(step % 2 ** 32, 4);
  const h = createHmac('sha1', key).update(msg).digest();
  const off = (h[h.length - 1] ?? 0) & 0x0f;
  const bin = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, '0');
}

/** 某一时刻（毫秒）的 6 位码。 */
export function totpAt(secretB32: string, nowMs: number): string {
  return codeForStep(base32Decode(secretB32), Math.floor(nowMs / STEP_MS));
}

/**
 * 校验 6 位码：命中当前步或前后各一步 → 返回命中的**步数**（调用方据此防重放）；否则 null。
 * @why 返回步数而不是布尔：同一个码在 90 秒窗口内都有效，不记"用过哪一步"，偷看到的码可以再用一次。
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = Math.floor(nowMs / STEP_MS);
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d += 1) {
    if (codeForStep(key, now + d) === code) return now + d;
  }
  return null;
}

/** 新密钥：20 字节随机（160 位，RFC 4226 §4 推荐长度）→ 32 个 base32 字符。 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** 验证器 App 扫码 / 手输用的 otpauth URI（Key Uri Format）。 */
export function totpUri(secretB32: string, account: string, issuer: string): string {
  const i = encodeURIComponent(issuer);
  return (
    `otpauth://totp/${i}:${encodeURIComponent(account)}?secret=${secretB32}` +
    `&issuer=${i}&algorithm=SHA1&digits=${String(DIGITS)}&period=${String(STEP_MS / 1000)}`
  );
}
