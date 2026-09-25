/**
 * 职责：一键灌数据的**安全闸门**单测（F9-f，L0 层、不连库）。
 *
 * @why 闸门是一键灌数据唯一"错了就不可逆"的部分——对着远程库跑 truncate 没有后悔药。
 *      所以它的每一条拒绝路径都要单独钉死，而不是只测"本机能灌"。
 *      这一组是**负向断言为主**：防的是"某天有人为了让某个环境能灌，把闸门改松"。
 *
 * @see scripts/seed-lib.ts（被测）；seed-lib.db.test.ts（幂等与配置表保留，真库）
 */
import { describe, expect, it } from 'vitest';
import { assertSafeTarget } from './seed-lib.js';

function expectThrow(url: string, contains: string): void {
  let thrown: unknown;
  try {
    assertSafeTarget(url);
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `URL 应被拒绝：${url}`).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(contains);
}

describe('闸门①：只灌本机', () => {
  it('接受 localhost 的各种写法', () => {
    expect(() => assertSafeTarget('postgresql://u@localhost:5432/japan_shop')).not.toThrow();
    expect(() => assertSafeTarget('postgresql://u@127.0.0.1:5432/japan_shop')).not.toThrow();
    expect(() => assertSafeTarget('postgresql://u@[::1]:5432/japan_shop')).not.toThrow();
  });

  it('拒绝远程主机（这是不可逆操作的底线）', () => {
    expectThrow('postgresql://u@db.render.com:5432/japan_shop', 'localhost');
    expectThrow('postgresql://u@192.168.1.10:5432/japan_shop', 'localhost');
    expectThrow('postgresql://u@staging.internal:5432/japan_shop', 'localhost');
  });

  it('拒绝无法解析的 URL', () => {
    expectThrow('not-a-url', 'DATABASE_URL');
  });
});

describe('闸门②：库名拒 prod', () => {
  it('库名含 prod / production 一律拒（哪怕在本机）', () => {
    expectThrow('postgresql://u@localhost:5432/japan_shop_prod', '生产');
    expectThrow('postgresql://u@localhost:5432/PRODUCTION', '生产');
    expectThrow('postgresql://u@127.0.0.1:5432/waselect_production', '生产');
  });

  it('dev / test 库名放行（含 prod 子串但语义不是生产的要小心）', () => {
    // @why 只拦"prod/production"这两个词，不拦"produce"等——闸门要宽严适度，
    //      拦太宽会把合法库名也挡掉，于是有人会把闸门删掉。
    expect(() => assertSafeTarget('postgresql://u@localhost:5432/japan_shop')).not.toThrow();
    expect(() => assertSafeTarget('postgresql://u@localhost:5432/japan_shop_test')).not.toThrow();
  });
});
