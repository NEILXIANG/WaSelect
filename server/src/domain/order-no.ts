/**
 * 职责：订单号的**生成规则**（domain 层的第一个居民）——JST 业务日 + 随机段。
 *
 * @why 这里只有十几行，但它是 domain 的第一个落点，意义不在代码量：
 *      "订单号用哪一天的日期"是一条**业务规则**（日本业务日，不是服务器本地日），
 *      规则就该住在 domain，而不是散落在路由里。路由负责"什么时候要一个单号"，
 *      domain 负责"单号是什么"。
 *
 * @why 时间**必须注入**（`Clock`）：见 `ports/clock.ts` 的 @why。
 *      具体到本规则：服务器在美西（Render Oregon），业务日在日本（JST = UTC+9），
 *      跨日边界落在 UTC 15:00。写死 `new Date()` 的话，
 *      "UTC 14:59:59 与 15:00:00 生成的单号必须跨天"这条规则**永远测不到**——
 *      要测就得等真实时间走到那一刻。
 *
 * @limitation 一：**只拼装，不判重**。冲突重试靠 `order_no` 的唯一约束捕获（D32，待办），
 *              那需要知道"这个号是否已存在"，是仓储层的事；domain 不知道存储。
 * @limitation 二：随机段仍由调用方传入（`randomOrderSeq()`），本模块不自己摇随机数——
 *              "摇号"是可注入的另一个输入（IdGen），与时钟同理，下一步端口化。
 * @limitation 三：`jstDateShort` 来自 `packages/shared`，domain 允许依赖 shared
 *              （纯函数、无 IO）；domain **不允许**依赖 adapters / app（F10 依赖方向）。
 *
 * @see ../ports/clock.ts；packages/shared/src/orderNo.ts（格式与口径的唯一事实来源）；
 *      packages/shared/src/businessDay.ts（JST 业务日）
 */
import { formatOrderNo, jstDateShort } from '@waselect/shared';
import type { Clock } from '../ports/clock.js';

/**
 * 生成一个订单号：`YYMMDD(JST) - 6 位随机段`。
 *
 * @param clock 时钟（注入）；日期段取 `clock.now()` 的 **JST** 业务日
 * @param seq   6 位随机段（`shared.randomOrderSeq()`；非法字符由 shared 抛 RangeError）
 */
export function buildOrderNo(clock: Clock, seq: string): string {
  return formatOrderNo(jstDateShort(clock.now()), seq);
}
