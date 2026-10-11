/**
 * 职责：错误码注册表的 L0 单测（HTTP 推导 / 登记判定 / 与契约不漂移）。
 * @see 技术文档 v0.5 §7；docs/测试策略与验证门禁.md §4
 */
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, errorSpec, httpStatusOf, isErrorCode } from './errors.js';

describe('httpStatusOf', () => {
  it('码前三位数即 HTTP 状态', () => {
    expect(httpStatusOf(40001)).toBe(400);
    expect(httpStatusOf(40101)).toBe(401);
    expect(httpStatusOf(40301)).toBe(403);
    expect(httpStatusOf(40401)).toBe(404);
    expect(httpStatusOf(40905)).toBe(409);
    expect(httpStatusOf(42901)).toBe(429);
    expect(httpStatusOf(50003)).toBe(500);
  });

  it('未知或非法码一律回落 500，不暴露未登记码', () => {
    expect(httpStatusOf(99999)).toBe(500);
    expect(httpStatusOf(123)).toBe(500);
  });
});

describe('注册表完整性', () => {
  /**
   * ⚠️ 这份清单是**手写**的（与 jp 技术文档 §7 对齐），不是从文档里读出来的——
   * 刻意不读文档：跨仓库文件依赖会让 CI / 新克隆直接崩（契约脚本已经踩过一次）。
   * 代价：增删错误码必须同步改这里，否则本例会红——这正是想要的效果。
   */
  it('技术文档 §7 的 36 个码全部登记，且不多不少（0.6.36 加 40916 / 40917；0.6.43 加 40918；0.6.69 加 41301）', () => {
    const expected = [
      40001, 40002, 40011, 40101, 40102, 40103, 40301, 40400, 40401, 40402, 40403, 40901, 40902,
      40903, 40904, 40905, 40906, 40907, 40908, 40909, 40910, 40911, 40912, 40913, 40914, 40915,
      40916, 40917, 40918, 41301, 42901, 50000, 50001, 50003, 50004, 50300,
    ];
    expect(expected.every((c) => isErrorCode(c))).toBe(true);
    expect(Object.keys(ERROR_CODES).length).toBe(expected.length);
  });

  it('50000 是未归类异常的兜底码，HTTP 500', () => {
    const spec = errorSpec(50000);
    expect(spec?.message).toBe('服务器内部错误');
    expect(httpStatusOf(50000)).toBe(500);
  });

  it('每个码都有文案与处理动作，且 code 字段自洽', () => {
    for (const spec of Object.values(ERROR_CODES)) {
      expect(spec.message.length).toBeGreaterThan(0);
      expect(spec.action.length).toBeGreaterThan(0);
      expect(httpStatusOf(spec.code)).toBe(Math.floor(spec.code / 100));
    }
  });

  /**
   * AJ-318（0.6.27）：拒付闸门的两个码 —— 40907（退款）/ 40909（发货）—— 覆盖的是
   * 「**有未解除的**拒付限制」，而**不只是"进行中"**：0.6.10① 起败诉同样保持
   * `has_dispute = true`，闸门在败诉后**继续拦**（钱已被机构拉回）。
   *
   * @why 旧文案写"存在**进行中的**拒付"，客服看到会去**等结案**——而那张单已经结案了
   *      （lost），等下去永远不会解锁，她只会得出"系统卡住了"，而不是
   *      "这笔钱已经被拉回、要先处理争议"。文案把人引向错误的动作，按 ADR-29 算 bug。
   * @why 钉住"文案覆盖败诉"而不是钉住整句：整句钉死会让每次措辞微调都红，
   *      而真正不能丢的是"这条闸门也会因败诉而开"这个**语义**。
   */
  it('40907 / 40909 的文案覆盖「已败诉」，不只是「进行中」（AJ-318）', () => {
    for (const code of [40907, 40909] as const) {
      const spec = errorSpec(code);
      expect(spec).toBeDefined();
      expect(spec?.message, `${String(code)} message`).toContain('未解除');
      expect(spec?.message, `${String(code)} message`).toContain('已败诉');
      expect(spec?.action, `${String(code)} action`).toContain('已败诉');
    }
  });

  it('未登记码返回 undefined（调用方应映射 500）', () => {
    expect(isErrorCode(49999)).toBe(false);
    expect(errorSpec(49999)).toBeUndefined();
  });
});
