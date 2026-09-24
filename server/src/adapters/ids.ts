/**
 * 职责：标识符生成的**真实实现**（F10）——桥到 Node 的随机源。
 *
 * @why 放在 `adapters/`：`crypto.randomUUID` 与 `Math.random` 都是进程之外的东西，
 *      和数据库、时钟一样属于"边界"。业务侧只见 `ports/ids.ts` 的 `IdGen`，
 *      将来换成密码学安全的随机段（见下）只改这一个文件。
 *
 * @limitation 一：随机段走 `shared.randomOrderSeq()` 的默认源，即 `Math.random`，
 *              **不是**密码学安全随机。当前取舍记录在 `shared/orderNo.ts @limitation 二`：
 *              随机段只防"推算日销量 / 枚举订单"，不承载权限，故默认源够用。
 * @upgrade 若将来要求"不可预测"（例如单号被用于客服核身的唯一凭据），
 *          改这一行即可：`randomOrderSeq(() => randomInt(0, 1e9) / 1e9)`（`node:crypto`）。
 *          之所以能"只改一行"，正是因为摇号被收在适配器里而不是散落业务代码——
 *          这就是本端口存在的具体回报。
 * @limitation 二：`uuid()` 用 `crypto.randomUUID()`（CSPRNG），与随机段**不同源**、强度也不同。
 *              这是刻意的：内部 id 会被写进日志与外键，碰撞的代价远大于单号碰撞（后者有重试）。
 *
 * @see ../ports/ids.ts（契约与全部设计理由）
 */
import { randomUUID } from 'node:crypto';
import { randomOrderSeq } from '@waselect/shared';
import type { IdGen } from '../ports/ids.js';

/** 系统标识符生成器：装配处注入生产用。 */
export const systemIdGen: IdGen = {
  orderSeq: () => randomOrderSeq(),
  uuid: () => randomUUID(),
};
