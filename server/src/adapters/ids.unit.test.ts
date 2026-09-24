/**
 * 职责：真实标识符生成器（`systemIdGen`）的用例。
 *
 * @why 它只有两行，但要钉住的是**口径**而不是实现：
 *      ① 随机段必须能被 `formatOrderNo` 接受——"生成的号自己拼不出合法单号"
 *         是最典型的一类自伤（字母表在 shared、生成在适配器，两边各改一次就裂了）；
 *      ② 同一天之内多次调用必须**真的不同**——摇号退化成常量时，
 *         系统不会报错，只会让 `order_no` 唯一约束在第二个订单上炸，
 *         而那会儿的报错信息指向"重复键"，没人会想到是随机源坏了。
 *
 * @limitation 不断言"分布均匀"（那需要统计检验，收益不抵复杂度），
 *              只断言"多次调用不全相同"这一条能抓出退化事故的最弱性质。
 */
import { describe, expect, it } from 'vitest';
import { ORDER_NO_PATTERN, formatOrderNo } from '@waselect/shared';
import { systemIdGen } from './ids.js';

/** UUID v4 的形状（版本位 4、变体位 8/9/a/b）。 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('systemIdGen（真实标识符生成器）', () => {
  it('orderSeq 产出的随机段能拼出合法单号（与 shared 字母表同源）', () => {
    for (let i = 0; i < 50; i += 1) {
      const seq = systemIdGen.orderSeq();
      // 拼装不抛错 = 字母表与长度都对
      const no = formatOrderNo('260919', seq);
      expect(ORDER_NO_PATTERN.test(no)).toBe(true);
    }
  });

  it('orderSeq 多次调用不全相同（摇号退化成常量必须红）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(systemIdGen.orderSeq());
    // 32^6 空间下 200 次全同的概率可忽略；全同只可能是"没在摇"
    expect(seen.size).toBeGreaterThan(1);
  });

  it('uuid 产出 UUID v4 且互不重复', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const id = systemIdGen.uuid();
      expect(UUID_V4.test(id)).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(100);
  });
});
