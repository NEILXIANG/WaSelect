/**
 * 职责：标识符生成的**真实实现**（F10）——桥到 Node 的随机源。
 *
 * @why 放在 `adapters/`：`crypto.randomUUID` 与 `Math.random` 都是进程之外的东西，
 *      和数据库、时钟一样属于"边界"。业务侧只见 `ports/ids.ts` 的 `IdGen`，
 *      将来换成密码学安全的随机段（见下）只改这一个文件。
 *
 * @limitation 一：`orderSeq` 的随机源是 `node:crypto` 的 `randomInt`（**CSPRNG**），不是 `Math.random`。
 *              @why 订单号对外暴露（支付短链、订单详情、客服沟通）；`Math.random` 可预测，
 *                   可预测的单号配上其它信息就是一条枚举订单的入口（PAY-001，2026-10-15）。
 *              @why 上界取 shared 的 `ORDER_SEQ_SPACE`（32⁶）而非就地写一个数：字母表长度只有一处定义，
 *                   取值空间也只该有一处——写错上界不会报错，只会让分布悄悄偏置。
 *              之所以"改一行就能换随机源"，正是因为摇号被收在适配器里而不是散落业务代码——
 *              这就是本端口存在的具体回报。
 * @limitation 二：`uuid()` 用 `crypto.randomUUID()`（同为 CSPRNG），与随机段**同源**。
 *              强度一致的理由：两者都是对外（或对外键）可见的标识符，没有哪一边"只防推算就够了"。
 *
 * @see ../ports/ids.ts（契约与全部设计理由）
 */
import { randomInt, randomUUID } from 'node:crypto';
import { ORDER_SEQ_SPACE, randomOrderSeq } from '@waselect/shared';
import type { IdGen } from '../ports/ids.js';

/** 系统标识符生成器：装配处注入生产用。 */
export const systemIdGen: IdGen = {
  // randomInt(上界) 返回 [0, 上界) 的整数，除以上界即得 [0,1)；上界整除字母表长度，故无取模偏置
  orderSeq: () => randomOrderSeq(() => randomInt(ORDER_SEQ_SPACE) / ORDER_SEQ_SPACE),
  uuid: () => randomUUID(),
};
