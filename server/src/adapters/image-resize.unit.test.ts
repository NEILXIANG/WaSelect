/**
 * 职责：`adapters/image-resize.ts`（sharp 三档缩放）的单测（I2 U-I2）。
 *
 * @why 用 sharp 现造测试图而不是提交 fixture 二进制：
 *      fixture 进仓库后没人知道它里面是什么（"假数据要像真的"的反面是"真数据来路不明"），
 *      现造的图尺寸/方向角都由用例自己声明，断言才有意义。
 * @why 输出必须再过一次 `sniffImageType`（domain 的判定）与 `sharp().metadata()`
 *      （独立读取方）——自己产自己断言是自证（§2 第 21 条）。
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { resizeToTiers } from './image-resize.js';
import { sniffImageType, IMAGE_TIERS } from '../domain/upload-image.js';

/** 现造 2400×1200 jpeg（横图，宽是 detail 档的 2 倍，保证三档都会真缩）。 */
async function makeJpeg(width = 2400, height = 1200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg()
    .toBuffer();
}

describe('resizeToTiers（三档缩放）', () => {
  it('产出三档，键形 img/{id}/{tier}.webp，且顺序与 IMAGE_TIERS 一致', async () => {
    const out = await resizeToTiers(await makeJpeg(), 'abc123');
    expect(out.map((t) => t.name)).toEqual(IMAGE_TIERS.map((t) => t.name));
    expect(out.map((t) => t.key)).toEqual([
      'img/abc123/thumb.webp',
      'img/abc123/card.webp',
      'img/abc123/detail.webp',
    ]);
    for (const t of out) expect(t.contentType).toBe('image/webp');
  });

  it('三档宽度 = 200/600/1200，高度按比例 1/2（2400×1200 → 200×100 等）', async () => {
    const out = await resizeToTiers(await makeJpeg(), 'abc123');
    const dims = await Promise.all(
      out.map(async (t) => {
        const m = await sharp(t.bytes).metadata();
        return { w: m.width, h: m.height };
      }),
    );
    expect(dims).toEqual([
      { w: 200, h: 100 },
      { w: 600, h: 300 },
      { w: 1200, h: 600 },
    ]);
  });

  it('输出真 webp：用 domain 的 sniffImageType 独立复验（不自我声明）', async () => {
    const out = await resizeToTiers(await makeJpeg(), 'abc123');
    for (const t of out) expect(sniffImageType(t.bytes)).toBe('webp');
  });

  it('小图不放大：100×50 输入的 thumb 仍是 100 宽（放大只会糊且体积更大）', async () => {
    const out = await resizeToTiers(await makeJpeg(100, 50), 'abc123');
    const m = await sharp(out[0]!.bytes).metadata();
    expect(m.width).toBe(100);
    expect(m.height).toBe(50);
  });

  it('EXIF orientation=6 归正：2400×1200 转正后是竖图——card 档 600×1200 而非 1200×600', async () => {
    // iPhone 直出横拍图常带 orientation=6（顺时针 90°）；
    // 不归正的表现是"管理端看着正常、小程序里躺倒"，且只有真机看得见。
    // ⚠️ 造图用 withMetadata({orientation})：withExif(IFD0.Orientation) 在 create 图上
    //    实测写不进去（三种调用顺序全部得到 orientation=1），这条用例本身就是探针。
    const rotated = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await resizeToTiers(rotated, 'abc123');
    const card = out.find((t) => t.name === 'card')!;
    const m = await sharp(card.bytes).metadata();
    // 转正：2400×1200 横图带 orientation=6 → 竖图 1200×2400 → 按宽 600 缩 → 600×1200
    expect(m.width).toBe(600);
    expect(m.height).toBe(1200);
    // 归正后标记必须清掉（不带标记的竖图才是"所见即所得"）
    expect(m.orientation).toBeUndefined();
  });

  /**
   * PAY3-02：商品详情长图（中日电商最常见的图形态）必须能上传。
   *
   * @why 修复前这里 **throw**：三档只按宽度缩放且 `withoutEnlargement`，宽度小于档宽的
   *      长图高度被原样保留 → 超过 WebP 单边 16383 的硬上限 → 编码阶段失败。
   *      路由把一切异常归成 40001 `image_decode_failed`，运营看到的是"这张图坏了"，
   *      而图完全合法。这是"错误码把排障方向带偏"的典型，不是"图有问题"。
   * @why 断言里**不含**具体宽度数字：限高是等比的，写死 614 会让 sharp 版本的取整差异
   *      变成红灯；要钉的是两个不变量——不超限、比例不变（比例跳变 = 被裁了）。
   * @limitation 这两条**必须显式给 timeout**（实测）：造 4500 万像素的图再跑三档重采样，
   *             单跑约 1.8s / 2.2s，而全量 `test:unit` 是 138 个文件并发——
   *             本机负载一高就顶到 vitest 默认的 5000ms 上限（gate 实测红过一次，
   *             失败信息是 `Test timed out` 而**不是**断言失败）。
   *             不要把尺寸调小来换速度：调小就测不到 16383 这个上限了，
   *             而那个上限正是本条存在的唯一理由。
   */
  it('详情长图 750×20000 → 三档都产出，高度 ≤ 16383 且长宽比不变（PAY3-02）', async () => {
    const out = await resizeToTiers(await makeJpeg(750, 20_000), 'abc123');
    const dims = await Promise.all(
      out.map(async (t) => {
        const m = await sharp(t.bytes).metadata();
        return { name: t.name, w: m.width ?? 0, h: m.height ?? 0 };
      }),
    );
    const ratio = 750 / 20_000;
    for (const d of dims) {
      expect(d.h).toBeGreaterThan(0);
      // ① 不超格式上限（唯一的硬约束）
      expect(d.h).toBeLessThanOrEqual(16_383);
      // ② 比例保持 → 证明是等比限高，不是 fit:'cover' 把中段裁掉了
      expect(d.w / d.h).toBeCloseTo(ratio, 3);
    }
    for (const t of out) expect(sniffImageType(t.bytes)).toBe('webp');
  }, 30_000);

  it('竖长图 1200×17000（宽已达 detail 档宽）→ 同样不超限（PAY3-02 第二种形态）', async () => {
    const out = await resizeToTiers(await makeJpeg(1200, 17_000), 'abc123');
    for (const t of out) {
      const m = await sharp(t.bytes).metadata();
      expect(m.height ?? 0).toBeLessThanOrEqual(16_383);
      expect(sniffImageType(t.bytes)).toBe('webp');
    }
  }, 30_000);

  it('垃圾字节 → rejects（调用方虽先 sniff，适配器自己不装认识）', async () => {
    await expect(resizeToTiers(Buffer.from('definitely not an image'), 'abc123')).rejects.toThrow();
  });
});
