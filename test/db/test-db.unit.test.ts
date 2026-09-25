/**
 * 职责：测试库连接串闸门的测试（D27）。
 *
 * @why `resetTestDb()` 会对库里**所有业务表** `TRUNCATE … CASCADE`。
 *      闸门是唯一挡在"环境变量配错 → 清空真实数据"之间的东西，
 *      而它平时**永远不触发**（正常配置下永远通过）——这种"从不报警的保险"
 *      最容易在没人注意的时候失效。所以它自己必须有测试。
 *
 * @limitation 只测规则本身，不真的去连一个非 `_test` 的库（那正是要避免的事）。
 */
import { describe, expect, it } from 'vitest';
import { assertIsTestDatabaseUrl, envOrDefault } from './test-db.js';

const local = 'postgres://someone@localhost:5432/japan_shop_test';

describe('测试库连接串闸门', () => {
  it('本机的 *_test 库放行', () => {
    expect(assertIsTestDatabaseUrl(local)).toBe(local);
    expect(assertIsTestDatabaseUrl('postgres://u@127.0.0.1:5432/other_test')).toBeTruthy();
    expect(assertIsTestDatabaseUrl('postgres://u@[::1]:5432/other_test')).toBeTruthy();
  });

  it('开发库（不以 _test 结尾）直接拒绝——这是防"清空真实数据"的核心一条', () => {
    expect(() => assertIsTestDatabaseUrl('postgres://u@localhost:5432/japan_shop')).toThrow(
      /_test/,
    );
    // 大小写/前缀都不算数：必须是后缀
    expect(() => assertIsTestDatabaseUrl('postgres://u@localhost:5432/test_japan_shop')).toThrow(
      /_test/,
    );
  });

  it('非本机主机一律拒绝（会清空远端库）', () => {
    expect(() =>
      assertIsTestDatabaseUrl('postgres://u@db.example.com:5432/japan_shop_test'),
    ).toThrow(/非本机主机/);
  });

  it('显式允许远端时才放行，且只对 *_test 生效（远端+非测试库仍拒绝）', () => {
    const remote = 'postgres://u@db.example.com:5432/japan_shop_test';
    expect(assertIsTestDatabaseUrl(remote, { allowRemote: true })).toBe(remote);
    expect(() =>
      assertIsTestDatabaseUrl('postgres://u@db.example.com:5432/prod_shop', { allowRemote: true }),
    ).toThrow(/_test/);
  });

  it('畸形连接串与空库名都要抛错（不能静默放过去）', () => {
    expect(() => assertIsTestDatabaseUrl('not a url')).toThrow(/无法解析/);
    expect(() => assertIsTestDatabaseUrl('postgres://u@localhost:5432/')).toThrow(/没有指定库名/);
  });
});

describe('envOrDefault：空串按「未设置」处理（2026-09-25 物化 .env 暴露的回归）', () => {
  it('空串 / 纯空白 / undefined 都回落到 fallback', () => {
    expect(envOrDefault('', () => 'fb')).toBe('fb');
    expect(envOrDefault('   ', () => 'fb')).toBe('fb');
    expect(envOrDefault(undefined, () => 'fb')).toBe('fb');
  });

  it('有值时取值，且 fallback 根本不被调用（惰性）', () => {
    let called = 0;
    const fallback = (): string => {
      called += 1;
      return 'fb';
    };
    expect(envOrDefault('real', fallback)).toBe('real');
    expect(called, 'fallback 有副作用时，"有值也调一次"就是 bug').toBe(0);
  });
});
