/**
 * 职责：`domain/dispute-input.ts` 的单测（I2 U-E1）。
 *
 * @why "传了却不认识的 status"必须响亮失败而不是当成"不过滤"（实现文件 @why 给了完整理由：
 *      静默不过滤会让运营看到列表突然变长、按"拒付激增"这个错的结论去查业务）。
 *      这条规则只有一条返回点，所以**尤其要验它真的会拦**——
 *      ⚠️ 一个只有一条守卫的函数，写错时最容易的表现是"永远不拦"，而那看起来一切正常。
 *
 * @why 枚举与契约双向比对：前端 `admin-web/src/risk/view.ts` 的 `DISPUTE_STATUS`
 *      与这里是同一条规则的两端（它渲染下拉、这里决定过不过滤）。
 *      抄一份清单会各自漂移；比对让"契约改了 enum"直接变成红灯。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { DISPUTE_STATUS, parseDisputeResult, parseDisputeStatus } from './dispute-input.js';

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return String((e.details as { reason?: unknown })?.reason ?? '');
    throw e;
  }
  throw new Error('预期抛 AppError，实际没有抛');
}

function codeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  throw new Error('预期抛 AppError，实际没有抛');
}

describe('parseDisputeStatus', () => {
  it('缺省 / null / 空串 → undefined（"看全部"是默认视图，不是错误）', () => {
    expect(parseDisputeStatus(undefined)).toBeUndefined();
    expect(parseDisputeStatus(null)).toBeUndefined();
    expect(parseDisputeStatus('')).toBeUndefined();
  });

  it('三个合法状态各自原样带出', () => {
    expect(parseDisputeStatus('open')).toBe('open');
    expect(parseDisputeStatus('won')).toBe('won');
    expect(parseDisputeStatus('lost')).toBe('lost');
  });

  it('🔴 传了但不认识 → 40001（静默当成"不过滤"会造出假的业务结论）', () => {
    for (const bad of ['Open', 'OPEN', 'opened', 'chargeback', '0', ' open']) {
      expect(
        codeOf(() => parseDisputeStatus(bad)),
        bad,
      ).toBe(40001);
    }
    expect(reasonOf(() => parseDisputeStatus('opened'))).toBe('dispute_status_invalid');
  });

  it('重复参数（Express 会给数组）→ 40001，不静默取第一个', () => {
    // ?status=open&status=lost → 选中一个运营没点的筛选项，比报错更难发现
    expect(codeOf(() => parseDisputeStatus(['open', 'lost']))).toBe(40001);
    expect(codeOf(() => parseDisputeStatus([]))).toBe(40001);
  });

  it('非字符串（数字 / 对象）→ 40001', () => {
    expect(codeOf(() => parseDisputeStatus(0))).toBe(40001);
    expect(codeOf(() => parseDisputeStatus({ status: 'open' }))).toBe(40001);
  });
});

describe('parseDisputeResult（结案结果：机构 status → won / lost / withdrawn）', () => {
  it('won / lost 各自带出', () => {
    expect(parseDisputeResult('won')).toBe('won');
    expect(parseDisputeResult('lost')).toBe('lost');
  });

  /**
   * B1 / AJ-193：这两个是"**结案但没输赢**"。
   * @why 旧实现在这里返回 undefined，`mount.ts` 随即抛 `dispute_result_unknown`——
   *      于是查询函（inquiry）关闭后 `has_dispute` 永远是 true，订单被永久锁死。
   *      ⚠️ 这条用例不只是"多认两个词"：它是整条 B1 的入口，缺了它后面全绿也白搭。
   */
  it('🔴 warning_closed / prevented → withdrawn（结案但**不计输赢**，不是 undefined）', () => {
    expect(parseDisputeResult('warning_closed')).toBe('withdrawn');
    expect(parseDisputeResult('prevented')).toBe('withdrawn');
  });

  it('🔴 未结案的状态（needs_response / under_review / warning_* 的在途两态）→ undefined，不是 lost', () => {
    /**
     * @why 把"还在答辩中"认成 lost 的后果最严重：拒付其实还有救，
     *      我方却按"已经输了"结案——风控页不再标红、退款闸门解锁，
     *      而举证期限可能还剩好几天。这类错误同样没有任何一方报错。
     */
    for (const s of [
      'warning_needs_response',
      'warning_under_review',
      'needs_response',
      'under_review',
    ]) {
      expect(parseDisputeResult(s), s).toBeUndefined();
    }
  });

  it('🔴 charge_refunded 按"认不出"处理（不映射成 lost：退款已由机构执行，后续动作不同）', () => {
    expect(parseDisputeResult('charge_refunded')).toBeUndefined();
  });

  it('机构没给（undefiened）/ 空串 → undefined（由落账方决定怎么办，不在这里猜）', () => {
    expect(parseDisputeResult(undefined)).toBeUndefined();
    expect(parseDisputeResult('')).toBeUndefined();
  });

  it('大小写不同也不认（不给"看起来像"留缝）', () => {
    expect(parseDisputeResult('Won')).toBeUndefined();
    expect(parseDisputeResult('LOST')).toBeUndefined();
  });
});

/** 与契约的双向比对：`DISPUTE_STATUS` 必须恰好等于 `Dispute.dispute_status` 的 enum。 */
describe('DISPUTE_STATUS 与契约的双向比对', () => {
  const yaml = readFileSync(
    resolve(import.meta.dirname, '../../../contracts/api-contract.yaml'),
    'utf8',
  );
  // 契约里 dispute_status 只出现一次（Dispute schema），且同一行还带 enum
  const line =
    yaml.split('\n').find((l) => l.includes('dispute_status: {type: string, enum:')) ?? '';

  it('抽到了 dispute_status 的 enum（契约改写成多行会失配）', () => {
    expect(line).toContain('dispute_status');
    expect(line).toContain('enum');
  });

  it('集合完全相等', () => {
    const m = /enum:\s*\[([^\]]+)\]/.exec(line);
    const inContract = (m?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(inContract).toEqual([...DISPUTE_STATUS]);
  });
});
