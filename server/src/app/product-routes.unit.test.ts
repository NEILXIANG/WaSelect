/**
 * 职责：`toImageSet`（`products.images` 的 JSONB 条目 → 契约 ImageSet）的纯函数单测
 * （0.6.28 / AJ-361）。
 *
 * @why 这里钉的是两条 db 层**测不全**的分支：
 *      ① `IMG_BASE_URL` **未配置** → 按 image_id 存的条目必须整键省略（返回 `null`），
 *         而不是吐一个拼不出域名的裸键。db 用例要走这一支得改全局配置，而"改配置"
 *         这件事本身会被同库里别的用例看见（串味），所以放在纯函数层钉。
 *      ② 三种形态（image_id / 三档 URL / 裸字符串）**都要**还能渲染——
 *         库里会同时存在新旧两种形态，少认一种的表现是"一半商品的图没了"且不报错。
 * @why 三档 URL 的期望值用 **`imageObjectKey` 生成**，不写死 `img/{id}/{tier}.webp`：
 *      写死等于把键形复制了一份，键形改了这里照样绿；而"键形只有 `domain/upload-image.ts`
 *      一处定义"正是 AJ-143 的结论（消费方自己拼档位 = 靠字符串巧合工作）。
 *
 * @see ./product-routes.ts（被测）；./product-routes.db.test.ts（真库行为层）；
 *      ../domain/upload-image.ts（键形唯一出处）；docs/自主决策记录.md AJ-361
 */
import { describe, expect, it } from 'vitest';
import { imageObjectKey } from '../domain/upload-image.js';
import { toImageSet } from './product-routes.js';

/** 合法 image_id（IdGen 形状：小写字母数字 + 连字符）。 */
const ID = 'img-7qk3m9vz2rx8';
const BASE = 'https://img.example.com';

describe('toImageSet（商品图条目 → ImageSet）', () => {
  it('{image_id} + 配了 IMG_BASE_URL → 三档 URL，键形取自 imageObjectKey', () => {
    expect(toImageSet({ image_id: ID }, BASE)).toEqual({
      thumb: `${BASE}/${imageObjectKey(ID, 'thumb')}`,
      card: `${BASE}/${imageObjectKey(ID, 'card')}`,
      detail: `${BASE}/${imageObjectKey(ID, 'detail')}`,
    });
  });

  it('IMG_BASE_URL 带尾部斜杠 → 不出现双斜杠（只在拼接处归一一次）', () => {
    const r = toImageSet({ image_id: ID }, `${BASE}///`);
    expect(r).not.toBeNull();
    for (const u of [r?.thumb, r?.card, r?.detail]) {
      // 掐掉协议那两个斜杠再判，否则 https:// 自己会被当成双斜杠
      expect(u?.slice('https://'.length)).not.toContain('//');
      expect(u?.startsWith(`${BASE}/img/`)).toBe(true);
    }
  });

  it('IMG_BASE_URL 未配置 → 返回 null（整键省略，不是吐裸键）', () => {
    expect(toImageSet({ image_id: ID }, undefined)).toBeNull();
  });

  it('image_id 不合法 → 返回 null 且不抛（脏数据只降级这一张图，不打 500）', () => {
    expect(toImageSet({ image_id: 'Bad_Id' }, BASE)).toBeNull();
    expect(toImageSet({ image_id: 'img/abc' }, BASE)).toBeNull();
    expect(toImageSet({ image_id: '' }, BASE)).toBeNull();
    // 非字符串：读路径不接受"看起来像"的值（写入侧已拦，这里只兜直改库的脏数据）
    expect(toImageSet({ image_id: 123 }, BASE)).toBeNull();
  });

  it('旧形态 {thumb,card,detail} → 原样透传（且不需要 IMG_BASE_URL）', () => {
    const legacy = { thumb: 'a', card: 'b', detail: 'c' };
    expect(toImageSet(legacy, undefined)).toEqual(legacy);
  });

  it('旧条目带 image_key 附加键 → 仍按三档透传（image_key 不是档位，不算混填）', () => {
    expect(
      toImageSet({ thumb: 'a', card: 'b', detail: 'c', image_key: 'img/x/detail.webp' }, undefined),
    ).toEqual({ thumb: 'a', card: 'b', detail: 'c' });
  });

  it('裸字符串（更早的一档 URL）→ 三档同源', () => {
    expect(toImageSet('https://old.example.com/a.webp', undefined)).toEqual({
      thumb: 'https://old.example.com/a.webp',
      card: 'https://old.example.com/a.webp',
      detail: 'https://old.example.com/a.webp',
    });
  });

  it('混填以 image_id 为准（写入侧已拒混填；读侧按"能渲染就渲染"处理）', () => {
    expect(toImageSet({ image_id: ID, thumb: 'a', card: 'b', detail: 'c' }, BASE)?.thumb).toBe(
      `${BASE}/${imageObjectKey(ID, 'thumb')}`,
    );
  });

  it('渲染不出来的条目 → null（null / 数组 / 空对象 / 三档缺一）', () => {
    expect(toImageSet(null, BASE)).toBeNull();
    expect(toImageSet(undefined, BASE)).toBeNull();
    expect(toImageSet([], BASE)).toBeNull();
    expect(toImageSet({}, BASE)).toBeNull();
    expect(toImageSet({ thumb: 'a', card: 'b' }, BASE)).toBeNull();
  });
});
