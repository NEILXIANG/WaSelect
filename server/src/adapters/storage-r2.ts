/**
 * 职责：Cloudflare R2 对象存储（ObjectStorage 端口的**生产驱动**，B1）。
 *
 * @why 它是上线路线图里 B1 的落地：此前 `STORAGE_DRIVER` 只有 `fs` 与 `memory`，
 *      而生产**两者都拒启**（Render 易失盘 / 进程内存：上传成功、随后图静默消失，
 *      且没有任何一方报错）⇒ 生产没有可用的存储驱动 ⇒ 商品图上传直接 50000。
 *      R2 是 S3 兼容接口，所以这里走的是 SigV4，不需要任何 SDK。
 *
 * @why **路径风格**（`/{bucket}/{key}`）而不是虚拟托管风格（`{bucket}.host`）：
 *      虚拟托管要给桶名配一张证书通配，桶名里有 `.` 时还会踩 TLS 校验的坑；
 *      路径风格对桶名没有要求，少一处"名字决定能不能连"的隐性约束。
 *
 * @why 出站走 `HttpClient` 端口而不是自己 `fetch`：超时 / 重试 / 熔断都在那一层。
 *      自己发等于再养一条没有超时保护的出站路径，而"没有超时"在生产上是请求永久挂起
 *      ——上传是运营在后台等的同步动作，挂死比报错难排查得多。
 *      PUT/DELETE 按 HTTP 语义幂等，重试不需要幂等键（见 ports/http-client.ts 的规则）。
 *
 * @limitation 一：**只验过签名算法**，没有对真桶发过一次请求（本机没有凭据）。
 *      签名向量来自 AWS 官方 botocore（见 `aws-sigv4.ts` 的 @measured），
 *      但"R2 的端点形态、region=auto、这些头够不够"仍需 L4 在真桶上验一次——
 *      上线检查清单里要单独勾这一项，不能靠本文件的绿灯代替。
 * @limitation 二：`delete` 把 **404 当成功**（端口要求幂等）：补偿路径可能重复调用，
 *      也可能那一档根本没写成。但**其它** 4xx 不当成功——那是"请求本身有问题"
 *      （凭据错 / 键非法），静默成功会让"存储根本没配好"伪装成"清理完成"。
 * @limitation 三：不实现 list / 分片上传 / 预签名 URL——端口没有这些消费方（ADR-28）。
 *
 * @see ports/storage.ts；adapters/http/aws-sigv4.ts；adapters/object-key.ts；
 *      docs/上线路线图-2026-10-01.md B1
 */
import type { Clock } from '../ports/clock.js';
import type { HttpClient } from '../ports/http-client.js';
import type { ObjectStorage } from '../ports/storage.js';
import { AppError } from '../errors.js';
import { assertSafeObjectKey } from './object-key.js';
import {
  authorizationHeader,
  amzDateOf,
  canonicalUri,
  R2_REGION,
  S3_SERVICE,
  sha256Hex,
} from './http/aws-sigv4.js';

export interface R2StorageDeps {
  http: HttpClient;
  clock: Clock;
  /** R2 账户 ID（端点主机名由它拼出）。 */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** 端点：`https://{accountId}.r2.cloudflarestorage.com`（桶名走路径，见文件头 @why）。 */
function endpointOf(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/** 空体摘要（DELETE 用）：SigV4 里它是固定常量，每次算不划算也不必。 */
const EMPTY_PAYLOAD_HASH = sha256Hex(Buffer.alloc(0));

export function createR2Storage(deps: R2StorageDeps): ObjectStorage {
  const host = `${deps.accountId}.r2.cloudflarestorage.com`;
  const base = endpointOf(deps.accountId);

  const urlOf = (key: string): string => `${base}/${deps.bucket}${canonicalUri(key)}`;

  /**
   * 组装签名头。
   * @why `host` 必须参与签名：SigV4 规定 host 是必签头，漏了它服务端算出的规范请求
   *      就与我们不同 ⇒ 403，而本地一切正常。
   */
  const signHeaders = (
    key: string,
    method: string,
    extra: Record<string, string>,
    payloadHash: string,
  ): Record<string, string> => {
    const amzDate = amzDateOf(deps.clock.now());
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extra,
    };
    return {
      ...headers,
      authorization: authorizationHeader({
        credentials: {
          accessKeyId: deps.accessKeyId,
          secretAccessKey: deps.secretAccessKey,
        },
        req: { method, canonicalUri: `/${deps.bucket}${canonicalUri(key)}`, headers, payloadHash },
        amzDate,
        region: R2_REGION,
        service: S3_SERVICE,
      }),
    };
  };

  return {
    async put(key, bytes, contentType) {
      assertSafeObjectKey(key);
      const payloadHash = sha256Hex(bytes);
      const res = await deps.http.send({
        method: 'PUT',
        url: urlOf(key),
        headers: signHeaders(key, 'PUT', { 'content-type': contentType }, payloadHash),
        body: bytes,
      });
      // 2xx 之外一律算失败：S3 兼容接口的成功响应是 200/204（ETag 我们不需要）
      if (res.status < 200 || res.status >= 300) {
        throw new AppError(50000, {
          reason: 'storage_put_failed',
          ctx: { status: res.status, key },
        });
      }
    },

    async delete(key) {
      assertSafeObjectKey(key);
      const res = await deps.http.send({
        method: 'DELETE',
        url: urlOf(key),
        headers: signHeaders(key, 'DELETE', {}, EMPTY_PAYLOAD_HASH),
      });
      // ⚠️ 404 = 幂等成功（@limitation 二）；其余 4xx/5xx 是"存储没配好"，不能静默
      if (res.status === 404) return;
      if (res.status < 200 || res.status >= 300) {
        throw new AppError(50000, {
          reason: 'storage_delete_failed',
          ctx: { status: res.status, key },
        });
      }
    },
  };
}
