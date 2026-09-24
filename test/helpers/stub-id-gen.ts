/**
 * 职责：测试用的**确定性 IdGen**（`IdGen` 的一个实现）。
 *
 * @why 与 `fixed-clock.ts` 成对存在：时钟固定之后，唯一还不确定的是 id。
 *      两个都固定，端到端测试就能断言"这张单的 id 与单号**就是**这两个值"，
 *      而不必先发请求、再从响应里把 id 抠出来做二次查询——
 *      后者的问题是：断言只能证明"拿到的和查到的一致"，证明不了"生成规则对"。
 *
 * @why 非法随机段**立刻抛**（而不是等到拼装时才被 shared 拒绝）：
 *      测试里手写的常量最容易把 `O`/`0`、`I`/`1` 写混，
 *      到拼装才炸的话，报错发生在被测代码里，排查方向会被带偏。
 *
 * @limitation 固定值意味着**同一服务内只能生成一张单**（`order_no` 有唯一约束）。
 *              需要多张单的用例请注入真实 `systemIdGen`——本替身天生用于"只建一张"的场景。
 */
import { ORDER_NO_PATTERN } from '@waselect/shared';
import type { IdGen } from '../../server/src/ports/ids.js';

export function stubIdGen(seq: string, uuid: string): IdGen {
  // 借 shared 的整串格式来校验随机段：不复制一份字母表（口径只有一个来源）
  if (!ORDER_NO_PATTERN.test(`260919-${seq}`)) {
    throw new RangeError(`stubIdGen 收到非法随机段：${seq}（须为 6 位 Crockford Base32 大写）`);
  }
  if (uuid.length === 0) {
    throw new RangeError('stubIdGen 收到空 uuid');
  }
  return { orderSeq: () => seq, uuid: () => uuid };
}
