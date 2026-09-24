/**
 * 职责：订单号规则的**边界**用例（domain 层第一份测试）。
 *
 * @why 本规则的全部风险都集中在"用哪一天"这一个点上，而这一点的错法有三种，
 *      每一种在**真实时间下都测不出来**：
 *        ① 用 UTC 日 → 日本时间每天 09:00 前下的单，单号日期是昨天；
 *        ② 用服务器本地日 → Render 是 UTC、开发机是 Asia/Shanghai，
 *           于是"本地绿、线上错"，而且错在哪个方向取决于部署在哪；
 *        ③ 写死 `new Date()` → 跨日那一秒的行为（UTC 14:59:59 → 15:00:00）
 *           只能靠"等到那一刻"复现，等于没有测试。
 *      时钟注入之后，这三种错法各对应一条**恒定**的红。
 *
 * @why 用例里的时刻刻意选 **2026-01-02**（远离"现在"）：
 *      若测试期望的日期恰好等于真实今天，那么把实现改回 `new Date()` 之后
 *      用例**仍然会绿**——注入的时钟根本没被用上也看不出来。
 *      期望值离真实时间越远，"没走注入"这件事暴露得越快。
 *
 * @limitation 这里**不测** `randomOrderSeq`（那属于 shared 的用例），
 *              也不测冲突重试（D32，属仓储层，见 domain/order-no.ts @limitation 一）。
 */
import { describe, expect, it } from 'vitest';
import { isValidOrderNo, parseOrderNoDate } from '@waselect/shared';
import type { Clock } from '../ports/clock.js';
import { buildOrderNo } from './order-no.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';

/**
 * 一个 6 位合法随机段（Crockford Base32，**不含 I/L/O/U**）。
 *
 * ⚠️ 这里刻意**不用**各处注释里的示例 `K7Q2ML`：那个串含 `L`，而 Crockford 字母表
 *    （以及 `shared/orderNo.ts` 的 `ORDER_NO_PATTERN`）是排除 `L` 的——
 *    也就是说仓库里多处注释所举的"标准示例"，我们自己的代码会**抛 RangeError 拒绝**。
 *    本用例因此成了那批注释的照妖镜（详见 docs/自主决策记录.md 与本文件的 @why）。
 */
const SEQ = 'K7Q2MN';

/** 可推进的时钟：用来证明"每次调用都重新取时间"，而不是第一次取到就缓存住。 */
function stepClock(startIso: string): Clock & { advance(ms: number): void } {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('buildOrderNo（订单号 = JST 业务日 + 随机段）', () => {
  it('日期段取 **JST** 日：UTC 与服务器本地日都不同的一天也能取对', () => {
    // 2026-01-02T15:30:00Z → JST 2026-01-03 00:30（已跨日）
    // 同一时刻的 UTC 日是 01-02；UTC+8 时区的本地日也是 01-02（23:30）。
    // 也就是说：只要实现用了 getDate()/getUTCDate() 而没做 +9 偏移，这条一定红。
    expect(buildOrderNo(fixedClock('2026-01-02T15:30:00Z'), SEQ)).toBe(`260103-${SEQ}`);
  });

  it('跨日边界正好落在 UTC 15:00：14:59:59.999 与 15:00:00.000 必须跨一天', () => {
    // @why 这条是"JST 业务日"这条口径的**定义**：JST = UTC+9，
    //      所以日本的新一天从 UTC 15:00 开始。边界两侧差 1 毫秒，结果必须差一天。
    //      写死 new Date() 时这条永远无法在 CI 里稳定复现——这正是注入时钟的理由。
    expect(buildOrderNo(fixedClock('2026-01-02T14:59:59.999Z'), SEQ)).toBe(`260102-${SEQ}`);
    expect(buildOrderNo(fixedClock('2026-01-02T15:00:00.000Z'), SEQ)).toBe(`260103-${SEQ}`);
  });

  it('月末跨月同样由 JST 决定：UTC 2 月最后一天 15:00 → JST 3 月 1 日', () => {
    expect(buildOrderNo(fixedClock('2026-02-28T15:00:00.000Z'), SEQ)).toBe(`260301-${SEQ}`);
  });

  it('每次调用都重新读时钟（时钟推进后日期跟着变，不是缓存第一次的值）', () => {
    const clock = stepClock('2026-01-02T14:00:00Z');
    expect(buildOrderNo(clock, SEQ)).toBe(`260102-${SEQ}`);
    clock.advance(2 * 60 * 60 * 1000); // +2h → UTC 16:00 → JST 01-03 01:00
    expect(buildOrderNo(clock, SEQ)).toBe(`260103-${SEQ}`);
  });

  it('产出物必须能通过 shared 的形状校验，且日期段可被解析回来', () => {
    const no = buildOrderNo(fixedClock('2026-09-24T00:00:00Z'), SEQ);
    expect(isValidOrderNo(no)).toBe(true);
    // 2026-09-24T00:00:00Z → JST 09-24 09:00（同一天）
    expect(parseOrderNoDate(no)).toBe('260924');
  });

  it('非法随机段直接抛 RangeError（口径在 shared，domain 不自己兜底）', () => {
    // @why 不吞掉：随机段不合法说明上游换了生成方式或手写了号，
    //      静默产出一个"看起来像单号"的脏串会让脏数据一路流到 DB 唯一约束才炸，
    //      那时已经分不清是拼装错还是摇号错。
    expect(() => buildOrderNo(fixedClock('2026-01-02T00:00:00Z'), 'abc')).toThrow(RangeError);
    // I/L/O/U 被 Crockford 字母表排除（防手抄混淆）
    expect(() => buildOrderNo(fixedClock('2026-01-02T00:00:00Z'), 'IO0000')).toThrow(RangeError);
  });

  it('不修改时钟返回的 Date（避免污染后续调用）', () => {
    // @why 端口约定 now() 每次返回新对象；**实现侧**若在某处对返回值做了就地运算
    //      （例如 `at.setHours(...)` 或 `at.setUTCHours(at.getUTCHours() + 9)`），
    //      共享同一实例的调用方之后拿到的就是被改过的时间——症状是"时间莫名跳了 9 小时"。
    const shared = new Date('2026-01-02T15:30:00Z');
    const clock: Clock = { now: () => shared };
    expect(buildOrderNo(clock, SEQ)).toBe(`260103-${SEQ}`);
    expect(shared.toISOString()).toBe('2026-01-02T15:30:00.000Z');
  });
});
