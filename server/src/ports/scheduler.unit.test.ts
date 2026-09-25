/**
 * 职责：调度器端口的 L0 单测——**只验纯判定**：错误文本归一化与"本轮算不算成功"。
 *
 * @why 这两件事看起来像"格式化小事"，实际是**看门狗能不能用**的前提：
 *      ① `last_error` 是运维看的第一眼。它若是一段 200KB 的 SQL 报错（带绑定参数值），
 *         日志系统要么截断要么丢弃，告警里只剩"失败了"三个字，等于没有；
 *      ② 错误原文里可能带邮箱/电话/卡号（例如"insert ... values ('a@b.com')"）——
 *         落进 `job_runs` 就是**绕过 redact 的持久化**，APPI 红线的口子就是这么开的；
 *      ③ "全成功才更新心跳"是一条判定规则，判错的表现是"明明有个 job 天天失败，
 *         看门狗却显示一切正常"——这类静默失效必须有个地方能测，而它不需要数据库。
 *
 * @how 全部用固定输入，不碰时间、不碰 IO。真库的互斥与心跳语义见
 *      `adapters/scheduler.db.test.ts`，编排（顺序/savepoint/提交后分发）见 `app/scheduler.unit.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
  allJobsOk,
  aggregateJobError,
  MAX_ERROR_CHARS,
  oneLineError,
  type JobResult,
} from './scheduler.js';

const ok = (name: string, processed = 1): JobResult => ({
  name,
  ok: true,
  processed,
  durationMs: 1,
});
const bad = (name: string, error = 'boom'): JobResult => ({
  name,
  ok: false,
  error,
  durationMs: 1,
});

describe('oneLineError：错误文本归一化（进 last_error 与日志）', () => {
  it('Error 取 message', () => {
    expect(oneLineError(new Error('连接被拒绝'))).toBe('连接被拒绝');
  });

  it('Error 的 message 为空时回落到 name（"有内容"优先，但绝不能是空串）', () => {
    // 空串进 last_error 的表现是"看门狗显示 last_error 有值但点开是空的"，比没有更糟
    expect(oneLineError(new Error(''))).toBe('Error');
  });

  it('非 Error（字符串 / 对象 / undefined）走 String()', () => {
    expect(oneLineError('plain')).toBe('plain');
    expect(oneLineError({ code: 7 })).toBe('[object Object]');
    expect(oneLineError(undefined)).toBe('undefined');
  });

  it('**脱敏**：错误里的邮箱必须打码（last_error 是持久化字段，不是日志）', () => {
    // @measured: maskText 保留**首字符 + 域名**（便于把同一用户的多次报错串起来），
    // 所以期望值是 'h***@example.com' 而不是全星号。写成"应该全遮住"会误判成缺陷。
    const masked = oneLineError(new Error('duplicate key for user hanako@example.com'));
    expect(masked).toBe('duplicate key for user h***@example.com');
    expect(masked).not.toContain('hanako@');
  });

  it('换行与连续空白折叠成单行（多行会让按行 grep 的日志系统只剩第一行）', () => {
    expect(oneLineError(new Error('line1\n  line2\t\tline3'))).toBe('line1 line2 line3');
  });

  it('去掉首尾空白后为空 → 给固定占位文案（而不是空串）', () => {
    expect(oneLineError(new Error('   \n\t  '))).toBe('(无错误信息)');
  });

  it('超过上限 → 截断并标注原始长度（便于判断"要不要去别处看完整栈"）', () => {
    const long = 'x'.repeat(MAX_ERROR_CHARS + 120);
    const out = oneLineError(new Error(long), 10);
    expect(out.startsWith('x'.repeat(10))).toBe(true);
    expect(out).toContain(`共 ${MAX_ERROR_CHARS + 120} 字符`);
  });

  it('正好等于上限 → 不截断（边界必须是"含"）', () => {
    expect(oneLineError(new Error('y'.repeat(10)), 10)).toBe('y'.repeat(10));
  });
});

describe('allJobsOk / aggregateJobError：本轮算不算成功', () => {
  it('全部成功 → ok', () => {
    expect(allJobsOk([ok('a'), ok('b')])).toBe(true);
    expect(aggregateJobError([ok('a'), ok('b')])).toBeUndefined();
  });

  it('空列表 → 视为成功（没有子任务就没有失败；`every` 的真空真在这里是对的）', () => {
    expect(allJobsOk([])).toBe(true);
    expect(aggregateJobError([])).toBeUndefined();
  });

  it('有一个失败 → 汇总里带上**名字**与比例（运维要一眼看出是谁、几分之几）', () => {
    const results = [ok('a'), bad('b', '超时'), ok('c')];
    expect(allJobsOk(results)).toBe(false);
    expect(aggregateJobError(results)).toBe('1/3 个子任务失败 → b: 超时');
  });

  it('多个失败 → 用 | 分隔，全部列出（不省略：job 数量是个位数，省略会误导）', () => {
    expect(aggregateJobError([bad('a', 'e1'), bad('b', 'e2')])).toBe(
      '2/2 个子任务失败 → a: e1 | b: e2',
    );
  });
});
