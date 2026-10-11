/**
 * 职责：`utils/server-clock.js` 的单测（MP-8，第二轮审计 2026-10-11）。
 * @why 钉三件事：① 头名大小写都认（实测经转发后变成小写 `date`）；② 坏值 / 缺失一律不校准；
 *      ③ 偏差小于阈值不动本机时刻（倒计时不随每个响应来回跳）。
 */
import { describe, expect, it } from 'vitest';
import { SKEW_APPLY_MS, serverNowMs, skewFromHeaders } from './server-clock.js';

/** 2026-10-10T14:03:07Z（@measured：Node 22 `Date.parse` 解析这个串得到的毫秒值）。 */
const SERVER_MS = 1791640987000;
const HTTP_DATE = 'Sat, 10 Oct 2026 14:03:07 GMT';

describe('skewFromHeaders（响应头 Date → 服务端比本机快多少毫秒）', () => {
  it('🔴 `Date` 与 `date` 两种头名都认（本地转发后实测是小写）', () => {
    expect(skewFromHeaders({ Date: HTTP_DATE }, SERVER_MS - 5 * 60_000)).toBe(5 * 60_000);
    expect(skewFromHeaders({ date: HTTP_DATE }, SERVER_MS + 120_000)).toBe(-120_000);
    expect(skewFromHeaders({ DATE: HTTP_DATE }, SERVER_MS)).toBe(0);
  });

  it('缺头 / 非字符串 / 解析不了 / 本机时刻非法 → null（不校准）', () => {
    for (const h of [
      undefined,
      null,
      'x',
      {},
      { date: 42 },
      { date: 'not a date' },
      { date: '' },
    ]) {
      expect(skewFromHeaders(h, SERVER_MS), JSON.stringify(h)).toBeNull();
    }
    expect(skewFromHeaders({ date: HTTP_DATE }, Number.NaN)).toBeNull();
  });
});

describe('serverNowMs（判截止用的当前时刻）', () => {
  const LOCAL = SERVER_MS;

  it('🔴 手机时钟偏快 5 分钟 → 按服务端时刻算（不会提前判"已过期"）', () => {
    expect(serverNowMs(LOCAL, -5 * 60_000)).toBe(LOCAL - 5 * 60_000);
    expect(serverNowMs(LOCAL, 5 * 60_000)).toBe(LOCAL + 5 * 60_000);
  });

  it('偏差小于阈值 → 用本机时刻（Date 头只到秒、含往返时间；小偏差校准只会让倒计时跳动）', () => {
    expect(serverNowMs(LOCAL, SKEW_APPLY_MS - 1)).toBe(LOCAL);
    expect(serverNowMs(LOCAL, -(SKEW_APPLY_MS - 1))).toBe(LOCAL);
    expect(serverNowMs(LOCAL, SKEW_APPLY_MS)).toBe(LOCAL + SKEW_APPLY_MS);
  });

  it('没有校准值（undefined / null / NaN / 非数字）→ 本机时刻', () => {
    for (const s of [undefined, null, Number.NaN, '600000', Infinity]) {
      expect(serverNowMs(LOCAL, s), String(s)).toBe(LOCAL);
    }
  });
});
