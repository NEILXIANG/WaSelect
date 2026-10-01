/**
 * 职责：`domain/banner-input.ts` 的单测（I2 U-D1）。
 *
 * @why 规则与前端 `admin-web/src/banners/view.ts` 的 `bannerFormErrors` **逐条对齐**，
 *      并且这里用**契约**做双向比对（而不是抄一份清单）：
 *      两端的校验一旦漂移，表现是"前端放行、服务端 40001"或反过来，
 *      而运营看到的是"保存失败但没有原因"（err.details 只进日志，见 admin-product-routes @limitation 一）。
 *
 * @limitation 只测纯校验；"存进去是不是真的按 sort 排序返回"由仓储与路由的用例证明。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { BANNER_LINK_TYPES, parseBannerInput } from './banner-input.js';

function codeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  throw new Error('预期抛 AppError，实际没有抛');
}

/** reason 进日志，是排障时区分"哪一条拦的"的唯一线索（同类教训见 shipping-rates-input 单测）。 */
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return String((e.details as { reason?: unknown })?.reason ?? '');
    throw e;
  }
  throw new Error('预期抛 AppError，实际没有抛');
}

const OK = { image_key: 'banners/2026/a.png' };

describe('parseBannerInput', () => {
  it('body 不是对象 → 40001', () => {
    expect(codeOf(() => parseBannerInput(null))).toBe(40001);
    expect(codeOf(() => parseBannerInput([]))).toBe(40001);
  });

  it('image_key 缺失 / 空白 → 40001（契约 required）', () => {
    expect(codeOf(() => parseBannerInput({}))).toBe(40001);
    expect(codeOf(() => parseBannerInput({ image_key: '  ' }))).toBe(40001);
    expect(reasonOf(() => parseBannerInput({}))).toBe('image_key_required');
  });

  it('link_type 不在枚举内 → 40001；缺省 = none', () => {
    // ⚠️ 必须**带上 link_id**：否则"枚举外"和"缺 link_id"两条守卫同时命中，
    // 而它们同码 40001——注入"枚举放宽"时用例仍绿（覆盖假象，第三次踩到同一个坑）。
    // 断言 reason 才能证明拦下它的**是**枚举那条。
    const bad = { ...OK, link_type: 'url', link_id: 'p-1' };
    expect(codeOf(() => parseBannerInput(bad))).toBe(40001);
    expect(reasonOf(() => parseBannerInput(bad))).toBe('link_type_invalid');
    expect(parseBannerInput(OK).linkType).toBe('none');
  });

  it('🔴 link_type ≠ none 而 link_id 空 → 40001（点了会跳到不存在的页面）', () => {
    expect(codeOf(() => parseBannerInput({ ...OK, link_type: 'product' }))).toBe(40001);
    expect(reasonOf(() => parseBannerInput({ ...OK, link_type: 'product' }))).toBe(
      'link_id_required',
    );
    expect(codeOf(() => parseBannerInput({ ...OK, link_type: 'product', link_id: '  ' }))).toBe(
      40001,
    );
    expect(codeOf(() => parseBannerInput({ ...OK, link_type: 'category' }))).toBe(40001);
    // link_type=none 时不要求 link_id（带了也保留，不静默丢）
    expect(parseBannerInput({ ...OK, link_id: 'x' }).linkId).toBe('x');
  });

  it('sort：非整数 / 负数 → 40001；缺省 0；0 合法', () => {
    expect(codeOf(() => parseBannerInput({ ...OK, sort: -1 }))).toBe(40001);
    expect(codeOf(() => parseBannerInput({ ...OK, sort: 1.5 }))).toBe(40001);
    expect(parseBannerInput(OK).sort).toBe(0);
    expect(parseBannerInput({ ...OK, sort: 0 }).sort).toBe(0);
  });

  it('起止时间：非法 → 40001；只给一个合法；缺省 null', () => {
    expect(codeOf(() => parseBannerInput({ ...OK, starts_at: 'yesterday' }))).toBe(40001);
    expect(codeOf(() => parseBannerInput({ ...OK, ends_at: 'x' }))).toBe(40001);
    const one = parseBannerInput({ ...OK, starts_at: '2026-10-01T00:00:00Z' });
    expect(one.startsAtMs).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(one.endsAtMs).toBeNull();
    expect(parseBannerInput(OK).startsAtMs).toBeNull();
  });

  /**
   * 🔴 DOM3-03：与 fx 同一条口径——`starts_at` / `ends_at` 在契约里是
   * `format: date-time`（偏移必填）。不带偏移的串会被 `Date.parse` 按进程时区解释，
   * "零点上线"在生产上变成早上 8 点（本机 JST vs Render UTC）。
   */
  it('🔴 起止时间不带偏移 → 40001（DOM3-03）', () => {
    for (const raw of ['2026-10-01T00:00', '2026-10-01 00:00:00', '1']) {
      expect(codeOf(() => parseBannerInput({ ...OK, starts_at: raw }))).toBe(40001);
      expect(codeOf(() => parseBannerInput({ ...OK, ends_at: raw }))).toBe(40001);
    }
    // 带偏移的同样时刻仍收
    expect(parseBannerInput({ ...OK, starts_at: '2026-10-01T00:00:00+09:00' }).startsAtMs).toBe(
      Date.parse('2026-09-30T15:00:00Z'),
    );
  });

  it('🔴 结束早于（等于）开始 → 40001（填反了 banner 永远不展示，且没人报错）', () => {
    const bad = { ...OK, starts_at: '2026-10-02T00:00:00Z', ends_at: '2026-10-01T00:00:00Z' };
    expect(codeOf(() => parseBannerInput(bad))).toBe(40001);
    expect(reasonOf(() => parseBannerInput(bad))).toBe('period_reversed');
    // 相等也不行：区间为空 = 永不命中
    const same = { ...OK, starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-10-01T00:00:00Z' };
    expect(codeOf(() => parseBannerInput(same))).toBe(40001);
  });

  it('active 缺省 true；显式 false 保留（下架是合法操作）', () => {
    expect(parseBannerInput(OK).active).toBe(true);
    expect(parseBannerInput({ ...OK, active: false }).active).toBe(false);
  });

  it('image_key 两侧空白被 trim；合法输入原样带出', () => {
    const v = parseBannerInput({
      image_key: '  banners/2026/a.png  ',
      link_type: 'product',
      link_id: 'p-1',
      sort: 3,
      active: false,
      starts_at: '2026-10-01T00:00:00Z',
      ends_at: '2026-10-02T00:00:00Z',
    });
    expect(v).toEqual({
      imageKey: 'banners/2026/a.png',
      linkType: 'product',
      linkId: 'p-1',
      sort: 3,
      active: false,
      startsAtMs: Date.parse('2026-10-01T00:00:00Z'),
      endsAtMs: Date.parse('2026-10-02T00:00:00Z'),
    });
  });
});

/**
 * ⚠️ 与契约的双向比对：`BANNER_LINK_TYPES` 必须恰好等于 `BannerInput.link_type` 的 enum。
 * @why 少一个 = 配不出某种跳转；多一个 = 接受一个契约不认的值。
 *      与前端 `banners/view.unit.test.ts` 的同名用例是同一条防线的两端。
 */
describe('BANNER_LINK_TYPES 与契约的双向比对', () => {
  const yaml = readFileSync(
    resolve(import.meta.dirname, '../../../contracts/api-contract.yaml'),
    'utf8',
  );
  const line = yaml.split('\n').find((l) => l.includes('link_type: {type: string, enum:')) ?? '';

  it('抽到了 link_type 的 enum（契约改写成多行会失配）', () => {
    expect(line).toContain('link_type');
    expect(line).toContain('enum');
  });

  it('集合完全相等', () => {
    const m = /enum:\s*\[([^\]]+)\]/.exec(line);
    const inContract = (m?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(inContract).toEqual([...BANNER_LINK_TYPES]);
  });
});
