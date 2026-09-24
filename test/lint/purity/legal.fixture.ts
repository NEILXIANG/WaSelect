/**
 * 职责：**合法**夹具——同一个需求（要个时间、要个 id）写成注入形态。
 *
 * @why 只测"违规会红"的门禁会被一条"禁止一切"的规则轻松骗过（全绿，但代码没法写）。
 *      合法与非法必须**成对**断言：这里断言注入形态一条都不报。
 */
import type { Clock } from '../../../server/src/ports/clock.js';
import type { IdGen } from '../../../server/src/ports/ids.js';

export function legal(clock: Clock, idGen: IdGen): { at: string; id: string; seq: string } {
  return { at: clock.now().toISOString(), id: idGen.uuid(), seq: idGen.orderSeq() };
}
