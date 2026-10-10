/** 职责：待付款倒计时文案（剩余清单 4-11 / A24）。 */
import { describe, expect, it } from 'vitest';
import { EXPIRED_TEXT, countdownText } from './countdown.js';

const EXP = '2026-10-06T10:30:00.000Z';
const at = (iso: string) => Date.parse(iso);

describe('countdownText', () => {
  // 三端联动模拟（2026-10-10）：原文"请在 17:08 内完成支付"读起来像钟点（下午五点零八分前），
  // 而它是"还剩 17 分 08 秒"。改用"分 / 秒"字样，不再出现冒号。
  it('🔴 剩余时间 → "请在 m 分 ss 秒内完成支付"（不足 1 分钟只写秒；超过 1 小时加"小时"）', () => {
    expect(countdownText(EXP, at('2026-10-06T10:15:30.000Z'))).toEqual({
      text: '请在 14 分 30 秒内完成支付',
      expired: false,
    });
    expect(countdownText(EXP, at('2026-10-06T10:25:55.000Z'))).toEqual({
      text: '请在 4 分 05 秒内完成支付',
      expired: false,
    });
    expect(countdownText(EXP, at('2026-10-06T10:29:58.400Z'))).toEqual({
      text: '请在 2 秒内完成支付',
      expired: false,
    });
    expect(countdownText(EXP, at('2026-10-06T09:00:00.000Z'))).toEqual({
      text: '请在 1 小时 30 分 00 秒内完成支付',
      expired: false,
    });
    expect(countdownText(EXP, at('2026-10-06T10:15:30.000Z')).text).not.toContain(':');
  });

  it('🔴 到点（含等号，与服务端关单同口径）→ expired，文案说清"时间已到"', () => {
    expect(countdownText(EXP, at(EXP))).toEqual({ text: EXPIRED_TEXT, expired: true });
    expect(countdownText(EXP, at('2026-10-06T11:00:00.000Z'))).toEqual({
      text: EXPIRED_TEXT,
      expired: true,
    });
  });

  it('expires_at 缺失 / 解析不了 → 不显示、也不判过期（不猜）', () => {
    expect(countdownText(undefined, 0)).toEqual({ text: '', expired: false });
    expect(countdownText('soon', 0)).toEqual({ text: '', expired: false });
  });
});
