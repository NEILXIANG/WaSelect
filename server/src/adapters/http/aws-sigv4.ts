/**
 * 职责：**AWS Signature Version 4 的签名计算**（S3 兼容对象存储专用）。
 *
 * @why 不引官方 SDK：R2/S3 只需要"签名一个请求"这一件事，而 SDK 会带进来一整棵依赖
 *      （凭据链、地区解析、重试栈、序列化层）；与 Stripe 那一处同一条判断——
 *      `stripe-checkout.ts` 也刻意自己算 HMAC。这里是同一类取舍的第二处。
 * @why 时间**由调用方传入**（`amzDate`），本模块不读 `Date.now()`：
 *      签名里的 `x-amz-date` 与签名结果是**时间的函数**，读全局时钟的后果是
 *      这条逻辑只能在真实时间下测试——而它恰恰是最不该出错、错了又最难查的一段
 *      （写错在生产上是 403，且没有任何一方会告诉你"是签名错了"）。
 *
 * @limitation 一：**不实现** query string 签名与分块上传（aws-chunked）。
 *              本项目的两个动作（PUT 对象 / DELETE 对象）都不带查询参数、都是单块；
 *              没有消费方的形态不实现（ADR-28）——将来真要分片上传时再补，
 *              届时夹具也要重新取一次（见 @measured）。
 * @limitation 二：**不处理** `x-amz-content-sha256: UNSIGNED-PAYLOAD` 这条捷径。
 *              我们手上有完整字节，算真实摘要更严格，也让"上传的字节被中途替换"
 *              这类问题在服务端就可查（摘要不匹配会被对象存储拒）。
 *
 * @measured 本文件的期望值**不是自己算出来的**：用 AWS 官方 botocore 1.43 的
 *           `S3SigV4Auth`（冻结时钟为 2013-05-24T00:00:00Z）生成，再抄进
 *           `aws-sigv4.unit.test.ts`。自证断言（自己实现 → 自己断言）抓不住签名错，
 *           所以夹具必须来自**另一个实现**。三份向量覆盖：虚拟托管风格 + 自定义 x-amz-* 头
 *           （AWS 文档经典形态）、R2 路径风格的空 body DELETE、R2 路径风格的二进制 PUT。
 *
 * @see docs/上线路线图-2026-10-01.md B1；adapters/storage-r2.ts（唯一使用者）；
 *      RFC 3986 §2.3（unreserved 字符集）
 */
import { createHash, createHmac } from 'node:crypto';

/** SigV4 的算法标识（拼在 `AWS4-HMAC-SHA256` 之后）。 */
const ALGORITHM = 'AWS4-HMAC-SHA256';
/** 签名终止标记（AWS 规定固定值）。 */
const TERMINATOR = 'aws4_request';
/** 对象存储固定服务名。 */
export const S3_SERVICE = 's3';
/**
 * R2 的 region 固定为 `auto`（Cloudflare 的规定值，不是可选配置）。
 * @why 不把它做成参数：没有第二个使用者，做成参数就有人会传错（`us-east-1` 也能算出签名，
 *      但 R2 会拒——而这类错误在启动期完全看不见，只在第一次上传时才响）。
 */
export const R2_REGION = 'auto';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** 参与签名的请求要素（**不含** Authorization 自身）。 */
export interface SigV4Request {
  method: string;
  /** 已**规范化**的路径（含前导 `/`；见 {@link canonicalUri}）。 */
  canonicalUri: string;
  /** 规范化查询串（本模块的使用者恒为空串）。 */
  canonicalQuery?: string | undefined;
  /** 待签名头（键小写）。`host` 必须给——它是 SigV4 的必签头。 */
  headers: Readonly<Record<string, string>>;
  /** 请求体摘要（十六进制）。空体 = `sha256Hex(Buffer.alloc(0))`。 */
  payloadHash: string;
}

/** `x-amz-date` 的格式：`YYYYMMDDTHHMMSSZ`，且 `dateStamp` 是它的前 8 位。 */
export function amzDateOf(now: Date): string {
  // ⚠️ 不用 `toISOString().replace(...)`：ISO 串带毫秒，而 SigV4 的 x-amz-date **不含**毫秒，
  //    多出来的 `.123` 会让服务端算出的签名与我们算的不同（403）。这里逐段取，只到秒。
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

/** SHA-256 十六进制摘要。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * RFC 3986 的 `unreserved` 字符集：`A-Z a-z 0-9 - . _ ~`。
 * 其余一律百分号编码（**大写**十六进制）。
 */
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * 按 RFC 3986 编码一段路径（**不含** `/`）。
 *
 * @why 不直接用 `encodeURIComponent`：它会**放过** `!'()*`，而 SigV4 要求这些字符
 *      一律百分号编码——键里出现这些字符时，我们算出的签名与服务端算的就不一致。
 *      本项目当前的键形（`img/{id}/{tier}.webp`，id 是小写字母数字与连字符）碰不到它，
 *      但端口是通用的，键形将来一变就会踩。
 */
export function encodeRfc3986(segment: string): string {
  let out = '';
  for (const ch of segment) {
    if (UNRESERVED.test(ch)) out += ch;
    else out += `%${Buffer.from(ch, 'utf8').toString('hex').toUpperCase()}`;
  }
  return out;
}

/**
 * 对象键 → 规范化 URI：`/` 是**分隔符**保留不编码，逐段编码。
 * @why 键里的 `/` 直接 `encodeURIComponent` 会变成 `%2F`——对象存储会把它当成一个
 *      名字里带斜杠的对象，拼出来的路径与"目录"语义完全不同，而删的时候删的是另一个键。
 */
export function canonicalUri(key: string): string {
  const segs = key.split('/').map(encodeRfc3986);
  return `/${segs.join('/')}`;
}

/** 头值规范化：去首尾空白、把连续内部空白压成一个（SigV4 规定）。 */
function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * 按头名排序后的 `name:value\n` 拼接（SigV4 要求字典序）。
 * @why 先建"小写名 → 原值"的表再取值：原先把键小写后**回原对象**取值，调用方一旦传了
 *      `Content-Type` 这类大小写混合的键，取到的是 `undefined`，签进摘要的是字符串 "undefined"
 *      ⇒ 403 SignatureDoesNotMatch（工程缺口第二轮 §3.6 #6；当时调用方全传小写，不可触发）。
 */
function canonicalHeaders(headers: Readonly<Record<string, string>>): string {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return [...lower.keys()]
    .sort()
    .map((k) => `${k}:${canonicalHeaderValue(String(lower.get(k)))}\n`)
    .join('');
}

/** 参与签名的头名列表（`;` 分隔，字典序）。 */
function signedHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort()
    .join(';');
}

/**
 * 规范请求（Canonical Request）——SigV4 的**第一段**。
 *
 * ```
 * METHOD\nCANONICAL_URI\nCANONICAL_QUERY\nCANONICAL_HEADERS\nSIGNED_HEADERS\nPAYLOAD_HASH
 * ```
 * ⚠️ 第 4 段与第 5 段之间是**两个**换行（头块本身以 `\n` 结尾，再补一个空行）。
 */
export function canonicalRequest(req: SigV4Request): string {
  const query = req.canonicalQuery ?? '';
  return [
    req.method,
    req.canonicalUri,
    query,
    canonicalHeaders(req.headers),
    signedHeaders(req.headers),
    req.payloadHash,
  ].join('\n');
}

/**
 * 待签串（String to Sign）——SigV4 的**第二段**。
 * @param amzDate `x-amz-date`（`YYYYMMDDTHHMMSSZ`）
 */
export function stringToSign(
  req: SigV4Request,
  amzDate: string,
  scope: { dateStamp: string; region: string; service: string },
): string {
  const hash = sha256Hex(Buffer.from(canonicalRequest(req), 'utf8'));
  return [
    ALGORITHM,
    amzDate,
    `${scope.dateStamp}/${scope.region}/${scope.service}/${TERMINATOR}`,
    hash,
  ].join('\n');
}

/**
 * 派生签名密钥：四段 HMAC 链（date → region → service → aws4_request）。
 * @why 逐段而不是一次性 HMAC：任何一段（换 region / 换服务）都能独立重算，
 *      这也是 AWS 规定这条链的原因（密钥不会跨服务通用）。
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  return createHmac('sha256', kService).update(TERMINATOR).digest();
}

export interface SignOptions {
  credentials: SigV4Credentials;
  req: SigV4Request;
  amzDate: string;
  region: string;
  service?: string;
}

/** 算出 `Authorization` 头的完整值。 */
export function authorizationHeader(opts: SignOptions): string {
  const service = opts.service ?? S3_SERVICE;
  const dateStamp = opts.amzDate.slice(0, 8);
  const sts = stringToSign(opts.req, opts.amzDate, {
    dateStamp,
    region: opts.region,
    service,
  });
  const key = deriveSigningKey(opts.credentials.secretAccessKey, dateStamp, opts.region, service);
  const signature = createHmac('sha256', key).update(sts, 'utf8').digest('hex');
  return (
    `${ALGORITHM} Credential=${opts.credentials.accessKeyId}/${dateStamp}/` +
    `${opts.region}/${service}/${TERMINATOR}, ` +
    `SignedHeaders=${signedHeaders(opts.req.headers)}, Signature=${signature}`
  );
}
