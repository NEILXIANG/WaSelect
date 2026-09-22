/**
 * 职责：测试用的内存日志 sink——**捕获 pino 真实输出**，而不是 mock 掉 logger。
 * @why 日志格式与脱敏正是要验的东西，mock 掉就等于没测；这里保留完整序列化链路，只把落点换成内存。
 * @limitation pino 写自定义 stream 是同步的，因此无需等待 flush；
 *             若将来换成 sonic-boom 异步文件落点，本 helper 需要加 `await flush()`。
 */
import type { DestinationStream } from 'pino';

export interface LogRow extends Record<string, unknown> {
  level: string;
  event: string;
  ts: string;
}

export class MemorySink implements DestinationStream {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line.trim());
  }

  /** 全部已解析的日志行。 */
  rows(): LogRow[] {
    return this.lines.map((l) => JSON.parse(l) as LogRow);
  }

  /** 最后一行（没有日志时抛出，避免测试静默通过）。 */
  last(): LogRow {
    const line = this.lines[this.lines.length - 1];
    if (line === undefined) throw new Error('还没有任何日志输出');
    return JSON.parse(line) as LogRow;
  }

  /** 按事件名过滤。 */
  find(event: string): LogRow[] {
    return this.rows().filter((r) => r.event === event);
  }

  clear(): void {
    this.lines.length = 0;
  }
}
