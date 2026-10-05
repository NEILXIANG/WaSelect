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
  isImageId,
  sniffImageType,
} from './upload-image.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractYaml = readFileSync(resolve(here, '../../../contracts/api-contract.yaml'), 'utf8');

/**
 * 契约 `ImageSet` 的 properties 段原文（两条用例共用）。
 * @why properties 值本身带花括号，取错一处两条断言会一起假绿；抽出来只写一次取法。
 */
const IMAGESET_PROPS =
  contractYaml.match(/ImageSet: \{type: object, properties: \{(.*)\}\}/)?.[1] ?? '';

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

describe('isImageId（0.6.28 / AJ-361：id 的**肯定式**形状判定）', () => {
  it('IdGen 形状 → true；URL / 大写 / 下划线 / 空串 → false', () => {
    expect(isImageId('abc123')).toBe(true);
    expect(isImageId('018f3c2a-7b1d-7e5f-9c2d-1a2b3c4d5e6f')).toBe(true);
    // ⚠️ 旧数据里的完整 URL 必须判 false——否则"读路径按 id 拼键"会把三档 URL 当成 id，
    //    拼出 img/https://…/thumb.webp，图全没了且不报错
    expect(isImageId('https://img.example.com/img/abc/thumb.webp')).toBe(false);
    expect(isImageId('img/abc123/detail.webp')).toBe(false);
    expect(isImageId('ABC123')).toBe(false);
    expect(isImageId('')).toBe(false);
    expect(isImageId('a_b')).toBe(false);
    expect(isImageId('-abc')).toBe(false);
  });

  it('与 imageObjectKey 同口径：判 true 的一定拼得出键，判 false 的一定抛', () => {
    // @why 防的是"判定与生成器各写一份规则"：今天两侧都读 IMAGE_ID_PATTERN，这条恒绿；
    //      哪天有人给某一侧另写一条（比如给读侧放宽成"不含 / 就算 id"），
    //      写入拦截与读侧降级就分叉了——而分叉的表现正是"存得进去、读不出来"。
    const canBuildKey = (s: string): boolean => {
      try {
        imageObjectKey(s, 'thumb');
        return true;
      } catch {
        return false;
      }
    };
    for (const s of ['abc123', 'a-b', 'https://x/y.webp', 'ABC', '', 'img/x', '018f-3c2a']) {
      expect(isImageId(s), `口径不一致：${s}`).toBe(canBuildKey(s));
    }
  });
});

describe('IMAGE_TIERS 与契约 ImageSet 双向比对', () => {
  it('tier 名集合 === 契约 ImageSet 的 URL 档键集合（image_key 除外）', () => {
    // ⚠️ properties 值本身带花括号（`{type: string}`），`[^}]+` 会在第一个内层 `}` 处断掉——
    //    用贪婪 `.*` 吃到行尾的 `\}\}`（properties 闭合 + schema 闭合）为止。
    expect(IMAGESET_PROPS, '契约里找不到 ImageSet 定义（结构变了本断言就该跟着改）').not.toBe('');
    const contractKeys = [...IMAGESET_PROPS.matchAll(/(\w+): \{type: string\}/g)]
      .map((x) => x[1] ?? '')
      // ⚠️ `image_id`（0.6.28 / AJ-361）与 `image_key` 都不是**档位**，只是随上传响应带出的
      //    附加键；新增非档位键必须同步加到这个过滤里，否则本条会把它当成一个不存在的档位。
      .filter((k) => k !== '' && k !== 'image_key' && k !== 'image_id')
      .sort();
    expect([...IMAGE_TIERS.map((t) => t.name)].sort()).toEqual(contractKeys);
  });

  it('ImageSet 声明了 image_key 与 image_id（两个"非档位"键都还在契约里）', () => {
    // @why 上一条只比对**档位**，挡不住"有人把 image_id 从契约里删掉"——
    //      那样上传响应仍在返回 image_id、代码仍在存它，但对外文档里没有它，
    //      调用方按契约写客户端就会发现"文档里没这个字段"（而服务端行为完全没变）。
    //      契约是本项目的对外承诺面，承诺面少一项要有人先红。
    // ⚠️ 按**声明形状**取（`key: {type: string`）而不是 `toContain('image_id')`：
    //    description 正文里也写着 `img/{image_id}/{tier}.webp`，子串匹配会在
    //    "字段被改名/删掉"之后照样绿——实测踩到（注入改名 → 17 条全绿）。
    const declared = [...IMAGESET_PROPS.matchAll(/(\w+): \{type: string/g)].map((x) => x[1] ?? '');
    expect(declared).toContain('image_key');
    expect(declared).toContain('image_id');
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
