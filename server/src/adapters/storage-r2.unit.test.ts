/**
 * 职责：`storage-r2.ts` 的单测——钉住"**发出去的那个请求长什么样**"。
 *
 * @why 签名算法本身由 `aws-sigv4.unit.test.ts` 对官方 botocore 的向量钉住；
 *      这里要钉的是另一层：**适配器有没有把正确的东西送进去**——
 *      端点拼对没有、region 是不是 `auto`、哪些头参与签名、body 有没有真的带上去、
 *      404 是不是被当成成功。这些错了的表现全是"上传失败"，而算法那一层全绿。
 *
 * @how 用假 `HttpClient` 捕获请求（不出网：外网闸门 AJ-56）+ 假时钟固定签名时间，
 *      于是 `Authorization` 是**可断言的确定值**——并且这个确定值同样来自 botocore
 *      （向量 ③），不是从实现里抄的。
 *
 * @limitation 这里绿灯**不等于**"真桶能通"（@limitation 一）：端点形态与"这些头够不够"
 *      仍要 L4 在真桶上验一次。本文件能证明的是"我们发出去的与 AWS 官方实现算的一致"。
 */
import { describe, expect, it } from 'vitest';
import type { Clock } from '../ports/clock.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../ports/http-client.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { createR2Storage, type R2StorageDeps } from './storage-r2.js';

/** 与 `aws-sigv4.unit.test.ts` 向量 ③ 同源（botocore 输出的那一组）。 */
const CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const NOW = '2013-05-24T00:00:00.000Z';
const KEY = 'products/p1/detail.webp';
const BUCKET = 'waselect-img';
const ACCOUNT = 'a1b2c3';

interface Captured {
  req: HttpRequest;
}

/** 假出站：记下每个请求，按 `status` 回一个空响应。 */
function fakeHttp(status: number): { http: HttpClient; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    http: {
      async send(req) {
        calls.push({ req });
        return { status, body: '', headers: {} } satisfies HttpResponse;
      },
    },
  };
}

function deps(http: HttpClient, clock: Clock): R2StorageDeps {
  return {
    http,
    clock,
    accountId: ACCOUNT,
    accessKeyId: CREDS.accessKeyId,
    secretAccessKey: CREDS.secretAccessKey,
    bucket: BUCKET,
  };
}

describe('createR2Storage.put', () => {
  /**
   * @measured（botocore 1.43.106，S3SigV4Auth，region=auto，时钟 2013-05-24T00:00:00Z）
   * 期望的 `Authorization` 与 `aws-sigv4.unit.test.ts` 向量 ③ 是同一份：
   * host=a1b2c3.r2.cloudflarestorage.com、canonicalUri=/waselect-img/products/p1/detail.webp、
   * content-type=image/webp、body='RIFFbinary'。
   */
  const EXPECTED_AUTHORIZATION =
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/auto/s3/aws4_request, ' +
    'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
    'Signature=4dd4d6222673cbd00731e23f8871832167c3c7dafa62a34abb958b4f85226d21';

  it('PUT：路径风格的 URL、二进制 body、签名头与 botocore 逐字一致', async () => {
    const f = fakeHttp(200);
    const storage = createR2Storage(deps(f.http, fixedClock(NOW)));
    const bytes = Buffer.from('RIFFbinary', 'utf8');

    await storage.put(KEY, bytes, 'image/webp');

    expect(f.calls).toHaveLength(1);
    const req = f.calls[0]?.req;
    expect(req?.method).toBe('PUT');
    // 路径风格：桶在路径里，不在主机名里（文件头 @why）
    expect(req?.url).toBe(
      `https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}/products/p1/detail.webp`,
    );
    // ⚠️ body 必须是**原字节**：传成字符串会按 UTF-8 重新解释，图片必坏且服务端摘要不符
    expect(Buffer.isBuffer(req?.body)).toBe(true);
    expect(req?.body).toEqual(bytes);
    expect(req?.headers?.['content-type']).toBe('image/webp');
    expect(req?.headers?.['host']).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(req?.headers?.['x-amz-date']).toBe('20130524T000000Z');
    expect(req?.headers?.['x-amz-content-sha256']).toBe(
      '5d5ec8e3036264fe21c4c927441368a79a31e0d9ec691c8cf1469bf0251f0253',
    );
    expect(req?.headers?.['authorization']).toBe(EXPECTED_AUTHORIZATION);
  });

  it('非 2xx → 抛 50000 storage_put_failed（带 status，排障要看得见是哪个码）', async () => {
    const f = fakeHttp(403);
    const storage = createR2Storage(deps(f.http, fixedClock(NOW)));
    await expect(storage.put(KEY, Buffer.from('x'), 'image/webp')).rejects.toMatchObject({
      code: 50000,
    });
  });
});

describe('createR2Storage.delete', () => {
  it('DELETE：无 body、空体摘要是固定常量', async () => {
    const f = fakeHttp(204);
    const storage = createR2Storage(deps(f.http, fixedClock(NOW)));
    await storage.delete(KEY);
    const req = f.calls[0]?.req;
    expect(req?.method).toBe('DELETE');
    expect(req?.body).toBeUndefined();
    expect(req?.headers?.['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(req?.headers?.['authorization']).toContain('SignedHeaders=host;x-amz-content-sha256;');
  });

  /**
   * @why 404 当成功是端口要求的幂等语义（@limitation 二）：补偿路径可能重复调用。
   *      但**只有** 404——把 403（凭据错）也当成功，会让"存储根本没配好"伪装成"清理完成"。
   */
  it('404 → 幂等成功（不抛）；403 → 抛（不能被静默成"清理完成"）', async () => {
    const notFound = fakeHttp(404);
    await expect(
      createR2Storage(deps(notFound.http, fixedClock(NOW))).delete(KEY),
    ).resolves.toBeUndefined();

    const denied = fakeHttp(403);
    await expect(
      createR2Storage(deps(denied.http, fixedClock(NOW))).delete(KEY),
    ).rejects.toMatchObject({ code: 50000 });
  });
});

describe('createR2Storage：键的安全校验（与 fs 驱动同一份实现）', () => {
  /**
   * @why 两个驱动必须**同一份**校验（object-key.ts 的 @why）：
   *      各写一份的话，收紧只发生在一边，于是某个 key 只在生产驱动上能写穿。
   */
  /**
   * @why 键形里带 `..` 但**首字符合法**的那一档（`img/../secret.webp`）必须单独列出来：
   *      `../etc/passwd` 会被正则的首字符就拒掉，根本走不到 `..` 判断——
   *      只用前者当样本的话，把 `..` 那一行删掉本用例照样绿（缺陷注回验证已实测，见 AJ-276）。
   */
  it('穿越键（`..` / 绝对路径 / 反斜杠）→ 抛且**不发请求**', async () => {
    for (const bad of [
      '../etc/passwd',
      '/abs/x.webp',
      'img\\x.webp',
      'img//x.webp',
      'img/../secret.webp',
    ]) {
      const f = fakeHttp(200);
      const storage = createR2Storage(deps(f.http, fixedClock(NOW)));
      await expect(storage.put(bad, Buffer.from('x'), 'image/webp')).rejects.toThrow(
        /object_key_unsafe/,
      );
      await expect(storage.delete(bad)).rejects.toThrow(/object_key_unsafe/);
      expect(f.calls, `不该对外发请求：${bad}`).toHaveLength(0);
    }
  });
});
