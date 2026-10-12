/**
 * 职责：`admin-web/src/banners/view.ts` 的单测。
 *
 * @why Banner 的两类失效都不报错：跳转型选了却没填 id（点了跳到不存在的页面）、
 *      起止时间填反（banner 永远不展示）。这两条只能靠保存前的形状校验拦下来。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unreadable } from '../../../test/helpers/readable.js';
import {
  LINK_LABELS,
  LINK_TYPES,
  bannerFormErrors,
  bannerFormModel,
  bannerRows,
  emptyBannerForm,
  toBannerInput,
} from './view.js';

const BANNER = {
  id: 'b-1',
  image_key: 'banners/2026/autumn-sale.png',
  image: 'https://img.example.com/banners/2026/autumn-sale.png',
  link_type: 'product',
  link_id: 'p-shiro-cleansing-oil',
  sort: 10,
  active: true,
  starts_at: '2026-10-01T00:00:00+09:00',
  ends_at: '2026-10-15T00:00:00+09:00',
};

const valid = (): Record<string, unknown> => ({
  imageKey: 'banners/2026/autumn-sale.png',
  linkType: 'product',
  linkId: 'p-shiro-cleansing-oil',
  sort: '10',
  active: true,
  startsAt: '2026-10-01T00:00',
  endsAt: '2026-10-15T00:00',
});

describe('bannerRows', () => {
  it('映射出列表行（时间是 JST）', () => {
    const [row] = bannerRows([BANNER]);
    expect(row).toMatchObject({
      id: 'b-1',
      imageUrl: 'https://img.example.com/banners/2026/autumn-sale.png',
      linkText: '商品：p-shiro-cleansing-oil',
      sortText: '10',
      active: true,
      periodText: '2026-10-01 00:00 → 2026-10-15 00:00',
    });
  });

  it('⚠️ 按 sort 升序（乱序会让运营以为排序没生效）', () => {
    const rows = bannerRows([
      { ...BANNER, id: 'b-2', sort: 30 },
      BANNER,
      { ...BANNER, id: 'b-3', sort: 1 },
    ]);
    expect(rows.map((r) => r.sortText)).toEqual(['1', '10', '30']);
  });

  it('⚠️ 缺 id 的行被丢掉（点了会打到 /admin/banners/undefined）', () => {
    expect(bannerRows([{ image_key: 'x' }, BANNER])).toHaveLength(1);
  });

  it('不跳转时只显示"不跳转"（不显示空 id）', () => {
    const [row] = bannerRows([{ ...BANNER, link_type: 'none', link_id: '' }]);
    expect(row?.linkText).toBe('不跳转');
  });

  it('非数组 → 空列表', () => {
    expect(bannerRows(null)).toEqual([]);
  });
});

describe('bannerFormModel', () => {
  it('编辑态：ISO 时间转成 datetime-local 能吃的形状（JST）', () => {
    expect(bannerFormModel(BANNER)).toEqual({
      imageKey: 'banners/2026/autumn-sale.png',
      linkType: 'product',
      linkId: 'p-shiro-cleansing-oil',
      sort: '10',
      active: true,
      startsAt: '2026-10-01T00:00',
      endsAt: '2026-10-15T00:00',
    });
  });

  it('⚠️ 未知 link_type 回落 none（不把脏值带进请求体）', () => {
    expect(bannerFormModel({ link_type: 'h5' }).linkType).toBe('none');
  });

  it('非对象 → 空表单', () => {
    expect(bannerFormModel(null)).toEqual(emptyBannerForm());
  });
});

describe('bannerFormErrors', () => {
  it('合法表单通过', () => {
    expect(bannerFormErrors(valid()).ok).toBe(true);
  });

  it('⚠️ 没传图片 → 拒（image_key 是契约必填）', () => {
    expect(bannerFormErrors({ ...valid(), imageKey: '' }).errors['imageKey']).toBeTruthy();
  });

  it('⚠️ 选了跳转型却没填 link_id → 拒（点了会跳到不存在的页面）', () => {
    const r = bannerFormErrors({ ...valid(), linkId: '  ' });
    expect(r.errors['linkId']).toBeTruthy();
  });

  it('不跳转时不需要 link_id', () => {
    expect(bannerFormErrors({ ...valid(), linkType: 'none', linkId: '' }).ok).toBe(true);
  });

  it('⚠️ link_type 不在枚举内 → 拒', () => {
    expect(bannerFormErrors({ ...valid(), linkType: 'h5' }).errors['linkType']).toBeTruthy();
  });

  it('⚠️ 起止时间填反 → 拒（填反了 banner 永远不展示，且没有任何一方会报错）', () => {
    const r = bannerFormErrors({
      ...valid(),
      startsAt: '2026-10-15T00:00',
      endsAt: '2026-10-01T00:00',
    });
    expect(r.errors['endsAt']).toContain('晚于');
  });

  it('sort 非整数或负数 → 拒', () => {
    expect(bannerFormErrors({ ...valid(), sort: '-1' }).errors['sort']).toBeTruthy();
    expect(bannerFormErrors({ ...valid(), sort: '1.5' }).errors['sort']).toBeTruthy();
  });

  // 两端输入测试 2026-10-12：填 99999999999 前端放行、服务端 500
  it('🔴 sort 超过 9999 → 拒，提示写明范围（与分类排序同口径）', () => {
    expect(bannerFormErrors({ ...valid(), sort: '10000' }).errors['sort']).toBe(
      '排序填 0–9999 的整数',
    );
    expect(bannerFormErrors({ ...valid(), sort: '99999999999' }).errors['sort']).toBe(
      '排序填 0–9999 的整数',
    );
    expect(bannerFormErrors({ ...valid(), sort: '9999' }).errors['sort']).toBe(undefined);
  });

  // 全入口点击测试 2026-10-12：空表单点保存，三处都写"图片必填（先上传，拿到 image_key）"——image_key 是字段名；
  // 跳转缺目标写"必须填目标 id"，可页面上是下拉框、运营从没见过 id；时间格式错写 YYYY-MM-DDTHH:mm
  it('🔴 所有提示都是人话：不出现字段名（image_key / link_id / snake_case）、"id"、格式串', () => {
    const msgs = [
      bannerFormErrors({ ...valid(), imageKey: '' }).errors,
      bannerFormErrors({ ...valid(), linkId: '  ' }).errors,
      bannerFormErrors({ ...valid(), linkType: 'category', linkId: '' }).errors,
      bannerFormErrors({ ...valid(), startsAt: '2026/10/01', endsAt: 'x' }).errors,
    ].flatMap((e) => Object.values(e));
    expect(msgs.length).toBeGreaterThanOrEqual(5);
    expect(unreadable(msgs)).toEqual([]);
    for (const m of msgs) {
      expect(m, m).not.toMatch(/\b[a-z]+_[a-z_]+\b|\bid\b|YYYY|HH:mm/i);
    }
    expect(bannerFormErrors({ ...valid(), imageKey: '' }).errors['imageKey']).toBe(
      '请先上传一张 Banner 图片',
    );
  });

  it('时间格式不对 → 拒（不是静默变成空）', () => {
    expect(
      bannerFormErrors({ ...valid(), startsAt: '2026/10/01' }).errors['startsAt'],
    ).toBeTruthy();
  });
});

describe('toBannerInput', () => {
  // 两端输入测试 2026-10-12：排序是文本框，全角「１」原先判"排序必须是整数"（实测后台页面）
  it('🔴 排序认全角数字：校验通过、发出去是数字', () => {
    expect(bannerFormErrors({ ...valid(), sort: '１２' }).errors['sort']).toBe(undefined);
    expect(toBannerInput({ ...valid(), sort: '１２' })['sort']).toBe(12);
  });

  it('输出契约 BannerInput 的形状', () => {
    expect(toBannerInput(valid())).toEqual({
      image_key: 'banners/2026/autumn-sale.png',
      link_type: 'product',
      link_id: 'p-shiro-cleansing-oil',
      sort: 10,
      active: true,
      starts_at: '2026-10-01T00:00:00+09:00',
      ends_at: '2026-10-15T00:00:00+09:00',
    });
  });

  it('⚠️ 不跳转时不带 link_id（带上会被当成"跳到空 id"）', () => {
    expect(Object.keys(toBannerInput({ ...valid(), linkType: 'none' }))).not.toContain('link_id');
  });

  it('⚠️ 时间为空则不带（传空串是非法 date-time）', () => {
    const body = toBannerInput({ ...valid(), startsAt: '', endsAt: '' });
    expect(Object.keys(body)).not.toContain('starts_at');
    expect(Object.keys(body)).not.toContain('ends_at');
  });

  it('⚠️ 不吃 image（那是服务端拼的 URL，不是输入）', () => {
    expect(Object.keys(toBannerInput({ ...valid(), image: 'https://x/y.png' }))).not.toContain(
      'image',
    );
  });
});

/**
 * ⚠️ 与契约的双向比对：`LINK_TYPES` 必须恰好等于 `BannerInput.link_type` 的 enum。
 * @why 少一个 = 配不出某种跳转；多一个 = 提交一个服务端必拒的值。
 */
describe('LINK_TYPES 与契约的双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../../contracts/api-contract.yaml'), 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('link_type: {type: string, enum:')) ?? '';

  it('抽到了 link_type 的 enum（契约改写成多行会失配）', () => {
    expect(line).toContain('link_type');
    expect(line).toContain('enum');
  });

  it('两边集合相等', () => {
    // ⚠️ 只取 enum 的方括号内部：BannerInput 那一行后面还有一堆别的属性，
    //    直接从头截到行尾会把 `type` / `link_id` 等词一起抽进来
    const bracket = /enum: \[([^\]]+)\]/.exec(line)?.[1] ?? '';
    const contract = bracket
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .sort();
    expect([...LINK_TYPES].sort()).toEqual(contract);
  });

  it('每个类型都有展示名（少一个会显示成 undefined）', () => {
    for (const t of LINK_TYPES) expect(LINK_LABELS[t], `${t} 缺展示名`).toBeTruthy();
  });
});

describe('排序只认纯数字（审查 2026-10-09 #6）', () => {
  it('🔴 空串 / 空格 / 1e2 / 小数 / 负数 → 拒；纯数字通过', () => {
    for (const bad of ['', '  ', '1e2', '1.5', '-1', '十']) {
      expect(
        bannerFormErrors({ ...valid(), sort: bad }).errors['sort'],
        `sort=${bad}`,
      ).toBeTruthy();
    }
    expect(bannerFormErrors({ ...valid(), sort: ' 12 ' }).ok).toBe(true);
    expect(toBannerInput({ ...valid(), sort: ' 12 ' })['sort']).toBe(12);
  });
});
