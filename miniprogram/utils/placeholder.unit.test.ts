/**
 * 职责：`utils/placeholder.js` 的单测——商品图取值与占位口径的唯一真源。
 *
 * @why `imageUrl` 的取值顺序（card → thumb → detail）与「非空判断」是实测修出来的：
 *      第一版用 `??`，`card: ''`（不是 nullish）会挡住后面有值的 thumb——
 *      详情页 vm 的单测当场红。没有这组用例，下次有人"顺手改回 ??"不会有任何东西报错。
 *
 * @see ./placeholder.js；../pages/home/index.vm.js（首页卡片消费方）；../pages/detail/index.vm.js
 */
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_IMAGE, imageUrl } from './placeholder.js';

describe('PLACEHOLDER_IMAGE', () => {
  it('是包内绝对路径（相对路径在小程序里按当前页面解析，会随页面漂移）', () => {
    expect(PLACEHOLDER_IMAGE).toMatch(/^\//);
  });
});

describe('imageUrl（取值顺序 card → thumb → detail）', () => {
  it('三键齐全 → 取 card（列表/详情主位要的是横图位）', () => {
    expect(imageUrl({ thumb: 't.jpg', card: 'c.jpg', detail: 'd.jpg' })).toBe('c.jpg');
  });

  it('⚠️ card 是**空串**（不是缺失）→ 仍要退化到 thumb（`??` 在这里会返回空串，实测踩过）', () => {
    expect(imageUrl({ thumb: 't.jpg', card: '', detail: '' })).toBe('t.jpg');
  });

  it('裸字符串（存量形态）→ 原样（去空格）', () => {
    expect(imageUrl('  a.jpg  ')).toBe('a.jpg');
  });

  it('缺 / 空串 / 三键皆空 / 非字符串非对象 → 空串（是否回落占位图由调用方决定）', () => {
    for (const v of [undefined, null, '', '   ', {}, { thumb: '', card: '', detail: '' }, 42]) {
      expect(imageUrl(v)).toBe('');
    }
  });
});
