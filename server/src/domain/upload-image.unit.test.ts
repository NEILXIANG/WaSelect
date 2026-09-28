/**
 * 职责：`domain/upload-image.ts`（上传图片的纯函数判定）的单测（I2 U-I1）。
 *
 * @why magic bytes 三条（jpeg/png/webp）必须逐族钉真值表——上传校验的整条防线就是
 *      "按字节不信声明"，这里错一位，放进来的是什么就没人知道了。
 * @why tier 名与契约 `ImageSet` 的 URL 档键**双向比对**：将来有人给 ImageSet 加一档
 *      （或从 IMAGE_TIERS 删一档）而忘了另一边，商品图就静默少一个尺寸，
 *      且没有任何一方报错（与"两个变量一起改"同族的覆盖假象，要双向才钉得住）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  IMAGE_TIERS,
  UPLOAD_MAX_BYTES,
  detailObjectKey,
  imageObjectKey,
  sniffImageType,
} from './upload-image.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractYaml = readFileSync(resolve(here, '../../../contracts/api-contract.yaml'), 'utf8');

describe('sniffImageType（magic bytes，不信 Content-Type）', () => {
  it('jpeg：FF D8 FF 开头即认（SOI + marker，3 字节足够）', () => {
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('jpeg');
  });
  it('png：8 字节签名全对才认', () => {
    expect(
      sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe('png');
  });
  it('png 签名错一位 → null（不能"差不多像"）', () => {
    expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]))).toBe(
      null,
    );
  });
  it('webp：RIFF....WEBP 双段都要对', () => {
    const b = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(sniffImageType(b)).toBe('webp');
  });
  it('RIFF 但不是 WEBP（如 WAV：RIFF....WAVE）→ null', () => {
    const b = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(sniffImageType(b)).toBe(null);
  });
  it('空 buffer / 只有 2 字节的 jpeg 头 → null（不足判定长度不猜）', () => {
    expect(sniffImageType(Uint8Array.from([]))).toBe(null);
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8]))).toBe(null);
  });
  it('判定只看字节：把 jpeg 字节命名为 x.png 也按 jpeg 认（注释用例：形状由调用方保证，这里钉"无文件名参数"）', () => {
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1]))).toBe('jpeg');
  });
});

describe('imageObjectKey / detailObjectKey（存储键形）', () => {
  it('三档 key 形状：img/{id}/{tier}.webp', () => {
    expect(imageObjectKey('abc123', 'thumb')).toBe('img/abc123/thumb.webp');
    expect(imageObjectKey('abc123', 'card')).toBe('img/abc123/card.webp');
    expect(imageObjectKey('abc123', 'detail')).toBe('img/abc123/detail.webp');
  });
  it('image_key 口径 = detail 档 key（AJ-166：单一真源，两处不许各写一份）', () => {
    expect(detailObjectKey('abc123')).toBe(imageObjectKey('abc123', 'detail'));
  });
  it('id 带路径穿越 / 大写 / 斜杠 → 抛错（id 只来自 IdGen，进不来；防将来接外部输入）', () => {
    expect(() => imageObjectKey('../etc', 'thumb')).toThrow();
    expect(() => imageObjectKey('ABC123', 'thumb')).toThrow();
    expect(() => imageObjectKey('a/b', 'thumb')).toThrow();
    expect(() => imageObjectKey('', 'thumb')).toThrow();
  });
  it('uuid 形（小写 + 连字符）放行——IdGen 的实际产出形状', () => {
    expect(imageObjectKey('018f3c2a-7b1d-7e5f-9c2d-1a2b3c4d5e6f', 'card')).toBe(
      'img/018f3c2a-7b1d-7e5f-9c2d-1a2b3c4d5e6f/card.webp',
    );
  });
});

describe('IMAGE_TIERS 与契约 ImageSet 双向比对', () => {
  it('tier 名集合 === 契约 ImageSet 的 URL 档键集合（image_key 除外）', () => {
    // ⚠️ properties 值本身带花括号（`{type: string}`），`[^}]+` 会在第一个内层 `}` 处断掉——
    //    用贪婪 `.*` 吃到行尾的 `\}\}`（properties 闭合 + schema 闭合）为止。
    const m = contractYaml.match(/ImageSet: \{type: object, properties: \{(.*)\}\}/);
    expect(m, '契约里找不到 ImageSet 定义（结构变了本断言就该跟着改）').not.toBe(null);
    const props = m![1];
    expect(props, 'ImageSet 的 properties 段为空').toBeDefined();
    const contractKeys = [...(props ?? '').matchAll(/(\w+): \{type: string\}/g)]
      .map((x) => x[1] ?? '')
      .filter((k) => k !== '' && k !== 'image_key')
      .sort();
    expect([...IMAGE_TIERS.map((t) => t.name)].sort()).toEqual(contractKeys);
  });
  it('档宽严格递增（thumb < card < detail）——反了就是缩略图比原图大', () => {
    const widths = IMAGE_TIERS.map((t) => t.width);
    for (let i = 1; i < widths.length; i++) {
      const prev = widths[i - 1];
      const cur = widths[i];
      expect(cur !== undefined && prev !== undefined && cur > prev).toBe(true);
    }
  });
});

describe('UPLOAD_MAX_BYTES', () => {
  it('上限 10MB（改动须同步契约 /admin/upload 描述）', () => {
    expect(UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
