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
import { DISPUTE_STATUS, parseDisputeStatus } from './dispute-input.js';

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
