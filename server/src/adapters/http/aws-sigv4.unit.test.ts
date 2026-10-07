/**
 * 职责：`aws-sigv4.ts` 的单测——钉住**签名算得对不对**。
 *
 * @why 这一段是全仓库最"错了也不会报错"的地方之一：签名算错在生产上是
 *      对象存储回 403，而日志里只有"上传失败"——没人会想到是签名错。
 *      更糟的是它**有测试也没用**：如果期望值是从自己的实现里抄出来的
 *      （自己算 → 自己断言），那实现与期望会一起错，而且永远是绿的（§2 第 21 条）。
 *
 * @how 期望值**全部来自 AWS 官方 botocore 1.43 的 `S3SigV4Auth`**（冻结时钟到
 *      2013-05-24T00:00:00Z 后取它的中间值与最终签名），详见被测文件的 @measured。
 *      本机复现命令（装在隔离 venv 里，不污染工程依赖）：
 *      `pip install botocore` → 跑 `scripts/` 之外的 oracle 脚本（见被测文件 @measured 的说明）。
 *
 * @limitation 这里只验**算法**。R2 的端点形态、region=auto、哪些头参与签名，
 *      由 `storage-r2.unit.test.ts` 用假 HttpClient 钉（那一层看的是"发出去什么"）。
 */
import { describe, expect, it } from 'vitest';
import {
  authorizationHeader,
  amzDateOf,
  canonicalRequest,
  canonicalUri,
  encodeRfc3986,
  sha256Hex,
  stringToSign,
  type SigV4Request,
} from './aws-sigv4.js';

/** 与 botocore 夹具一致的一组凭据（AWS 文档里的示例密钥对）。 */
const CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const AMZ_DATE = '20130524T000000Z';

interface Vector {
  label: string;
  req: SigV4Request;
  region: string;
  canonical: string;
  stringToSign: string;
  signature: string;
}

/**
 * @measured（botocore 1.43.106，S3SigV4Auth，时钟冻结 2013-05-24T00:00:00Z）
 * 三份向量：① AWS 文档经典形态（虚拟托管风格 + 自定义 `x-amz-storage-class`）；
 * ② R2 路径风格的空 body DELETE；③ R2 路径风格的二进制 PUT（region=auto）。
 */
const VECTORS: Vector[] = [
  {
    label: '① PUT 对象（虚拟托管风格 + 自定义 x-amz-* 头）',
    req: {
      method: 'PUT',
      canonicalUri: '/test%24file.text',
      headers: {
        'content-type': 'text/plain',
        host: 'examplebucket.s3.amazonaws.com',
        'x-amz-content-sha256': '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
        'x-amz-date': AMZ_DATE,
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    },
    region: 'us-east-1',
    canonical:
      'PUT\n/test%24file.text\n\ncontent-type:text/plain\n' +
      'host:examplebucket.s3.amazonaws.com\n' +
      'x-amz-content-sha256:44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072\n' +
      `x-amz-date:${AMZ_DATE}\nx-amz-storage-class:REDUCED_REDUNDANCY\n\n` +
      'content-type;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class\n' +
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    stringToSign:
      `AWS4-HMAC-SHA256\n${AMZ_DATE}\n20130524/us-east-1/s3/aws4_request\n` +
      '7185c4abaed3ccd1fbd9c210b7736f618472cb5c61fe1d8d865ef3c6fb17f122',
    signature: '2537cc94109e4e15c0eafaad99ec808aa23882107e4794520ac9cb50b57c4bdb',
  },
  {
    label: '② DELETE 对象（R2 路径风格，空 body，region=auto）',
    req: {
      method: 'DELETE',
      canonicalUri: '/waselect-img/products/p1/detail.webp',
      headers: {
        host: 'a1b2c3.r2.cloudflarestorage.com',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': AMZ_DATE,
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    region: 'auto',
    canonical:
      'DELETE\n/waselect-img/products/p1/detail.webp\n\n' +
      'host:a1b2c3.r2.cloudflarestorage.com\n' +
      'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n' +
      `x-amz-date:${AMZ_DATE}\n\nhost;x-amz-content-sha256;x-amz-date\n` +
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    stringToSign:
      `AWS4-HMAC-SHA256\n${AMZ_DATE}\n20130524/auto/s3/aws4_request\n` +
      '08e70954008a5be62d33cb575eaf94718418d930a7e7e63de85e1ced2a098ab0',
    signature: 'edc63b902d8bea65b2c93b80be117dea418945d1a7b69775ab7177be3014ba13',
  },
  {
    label: '③ PUT 对象（R2 路径风格，二进制 body，region=auto）',
    req: {
      method: 'PUT',
      canonicalUri: '/waselect-img/products/p1/detail.webp',
      headers: {
        'content-type': 'image/webp',
        host: 'a1b2c3.r2.cloudflarestorage.com',
        'x-amz-content-sha256': '5d5ec8e3036264fe21c4c927441368a79a31e0d9ec691c8cf1469bf0251f0253',
        'x-amz-date': AMZ_DATE,
      },
      payloadHash: '5d5ec8e3036264fe21c4c927441368a79a31e0d9ec691c8cf1469bf0251f0253',
    },
    region: 'auto',
    canonical:
      'PUT\n/waselect-img/products/p1/detail.webp\n\ncontent-type:image/webp\n' +
      'host:a1b2c3.r2.cloudflarestorage.com\n' +
      'x-amz-content-sha256:5d5ec8e3036264fe21c4c927441368a79a31e0d9ec691c8cf1469bf0251f0253\n' +
      `x-amz-date:${AMZ_DATE}\n\ncontent-type;host;x-amz-content-sha256;x-amz-date\n` +
      '5d5ec8e3036264fe21c4c927441368a79a31e0d9ec691c8cf1469bf0251f0253',
    stringToSign:
      `AWS4-HMAC-SHA256\n${AMZ_DATE}\n20130524/auto/s3/aws4_request\n` +
      'edc02ea07c8e64b16f1064298e236ff1e1bb6af9a9e58b176ced26991db12334',
    signature: '4dd4d6222673cbd00731e23f8871832167c3c7dafa62a34abb958b4f85226d21',
  },
];

describe('aws-sigv4：对官方 botocore 的三份向量', () => {
  for (const v of VECTORS) {
    it(v.label, () => {
      expect(canonicalRequest(v.req)).toBe(v.canonical);
      expect(
        stringToSign(v.req, AMZ_DATE, {
          dateStamp: AMZ_DATE.slice(0, 8),
          region: v.region,
          service: 's3',
        }),
      ).toBe(v.stringToSign);
      expect(
        authorizationHeader({
          credentials: CREDS,
          req: v.req,
          amzDate: AMZ_DATE,
          region: v.region,
        }),
      ).toContain(`Signature=${v.signature}`);
    });
  }
});

describe('aws-sigv4：形状与编码（这些是签名之外的独立失效点）', () => {
  /**
   * @why `x-amz-date` 带毫秒是 SigV4 的经典错法：`toISOString()` 给的是
   *      `2013-05-24T00:00:00.000Z`，直接 replace 掉横竖杠会留下 `.000`。
   *      服务端按不含毫秒的时间戳重算签名 ⇒ 403，而本地怎么测都是"格式对"。
   */
  it('amzDateOf 不含毫秒、且是 UTC（toISOString 的 .000 会让签名对不上）', () => {
    expect(amzDateOf(new Date('2013-05-24T00:00:00.000Z'))).toBe('20130524T000000Z');
    // 非 UTC 输入也要按 UTC 输出：服务跑在美西，业务日在日本
    expect(amzDateOf(new Date('2013-05-24T09:00:00+09:00'))).toBe('20130524T000000Z');
  });

  /** @why 键里出现 `'!' '(' ')' '*'` 时 `encodeURIComponent` 会放过它们 ⇒ 签名与服务端不一致。 */
  it('encodeRfc3986 编码 encodeURIComponent 会放过的 ! ( ) *', () => {
    expect(encodeRfc3986('a!b(c)d*e')).toBe('a%21b%28c%29d%2Ae');
    expect(encodeRfc3986('a-b_c.d~e')).toBe('a-b_c.d~e'); // unreserved 原样
    expect(encodeURIComponent('a!b(c)d*e')).not.toBe(encodeRfc3986('a!b(c)d*e')); // 两者确实不同
  });

  /** @why `/` 被编码成 `%2F` 后，对象存储会当成一个"名字里带斜杠"的对象——删的时候删的是另一个键。 */
  it('canonicalUri：保留 / 分隔符，逐段编码', () => {
    expect(canonicalUri('img/abc-123/detail.webp')).toBe('/img/abc-123/detail.webp');
    expect(canonicalUri('img/a b/detail.webp')).toBe('/img/a%20b/detail.webp');
  });

  it('sha256Hex：空体摘要是 SigV4 的固定常量（DELETE 用它）', () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  /** @why 头块与签名头列表之间是**两个**换行；少一个就整体错位，且只在服务端表现为 403。 */
  it('规范请求在头块与 SignedHeaders 之间恰好两个换行', () => {
    const cr = canonicalRequest({
      method: 'PUT',
      canonicalUri: '/k',
      headers: { host: 'h.example.com' },
      payloadHash: 'x'.repeat(64),
    });
    expect(cr).toBe('PUT\n/k\n\nhost:h.example.com\n\nhost\n' + 'x'.repeat(64));
  });

  it('🔴 头名大小写混合 → 值照样签进去（不是字符串 "undefined"）', () => {
    // 工程缺口第二轮 §3.6 #6：原先把键小写后回原对象取值，`Content-Type` 取到 undefined → 403 SignatureDoesNotMatch
    const cr = canonicalRequest({
      method: 'PUT',
      canonicalUri: '/k',
      headers: { Host: 'h.example.com', 'Content-Type': 'image/webp' },
      payloadHash: 'x'.repeat(64),
    });
    expect(cr).toContain('content-type:image/webp\nhost:h.example.com\n');
    expect(cr).not.toContain('undefined');
  });
});
