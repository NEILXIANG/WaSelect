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
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertIsTestDatabaseUrl, envOrDefault, testDbNameFor } from './test-db.js';

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

describe('testDbNameFor：project 分库（cov 一轮里 db 与 e2e 并发，共库会互删数据）', () => {
  it('默认层 = japan_shop_test；e2e = japan_shop_e2e_test，两者必须不同', () => {
    // @why 这条钉的是"分库"本身：两个名字一旦相同，分库就退化成共库，
    //      而共库的症状（随机 flake、只在 cov 一轮出现）不会在这里报出来。
    expect(testDbNameFor('')).toBe('japan_shop_test');
    expect(testDbNameFor('e2e')).toBe('japan_shop_e2e_test');
    expect(testDbNameFor('e2e')).not.toBe(testDbNameFor(''));
  });

  it('每个名字都仍以 _test 结尾（分库不能绕过"只准清测试库"的闸门）', () => {
    for (const p of ['', 'e2e', 'contract']) {
      expect(testDbNameFor(p).endsWith('_test')).toBe(true);
      // 真闸门跑一遍：不是"看起来以 _test 结尾"而是它确实能过
      expect(assertIsTestDatabaseUrl(`postgres://u@localhost:5432/${testDbNameFor(p)}`)).toContain(
        testDbNameFor(p),
      );
    }
  });

  it('非法标签一律抛错（会被拼进 create database，是注入面）', () => {
    for (const p of ['E2E', 'e2e;drop', '../x', 'e2e-test', ' x']) {
      expect(() => testDbNameFor(p), `标签 ${JSON.stringify(p)}`).toThrow(/标签不合法/);
    }
  });

  it('防复发：e2e project 必须真的注入了 TEST_DB_PROJECT（否则分库是死代码）', () => {
    // @why 分库生效依赖 vitest.config.mts 里那一处 `env`；删掉它测试照样全绿、
    //      flake 照样回来——这正是 §2 第 49 条"扫描型断言最容易写成自证"的场景，
    //      所以下面配了自检：先证明这根针能在一段已知文本里被找到。
    const needle = "TEST_DB_PROJECT: 'e2e'";
    expect(needle.length).toBeGreaterThan(0);
    const selfCheck = `env: { ${needle} }`;
    expect(selfCheck, '自检：这根针必须能在一段已知文本里被找到').toContain(needle);

    const cfg = readFileSync(new URL('../../vitest.config.mts', import.meta.url), 'utf8');
    expect(cfg.length, '自检：配置文件读到了内容，不是空串').toBeGreaterThan(0);
    expect(cfg, 'e2e project 必须注入 TEST_DB_PROJECT=e2e').toContain(needle);
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
