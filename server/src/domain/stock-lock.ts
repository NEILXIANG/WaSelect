/**
 * 职责：库存行锁的**全局取锁顺序**——建单扣减与（取消 / 关单）回补必须走同一个序。
 *
 * @why 放在 domain 而不是留在 `app/create-order.ts`：`adapters/orders.ts`（回补）也要用它，
 *      而 adapters **不得反向依赖 app**（F10 分层，ESLint 进 gate）。留在 app 里，回补就只能
 *      另写一份排序；两份序必然漂移，而"两个方向用不同的序"正是 AB / BA 死锁的定义。
 *      本文件是这两条路径**唯一的序**（F2 单一事实源）。
 *
 * @why SQL 侧也要显式 `collate "C"`（{@link PRODUCT_ID_LOCK_COLLATION}），不能只靠 JS 排序：
 *      回补是先 `select … order by product_id` 再按返回顺序逐行 UPDATE 的，
 *      排序发生在**库里**，用的是库的默认排序规则。本地库实测是 `C.UTF-8`，
 *      但生产库（Render PG）的默认 collation 未实测——`en_US.UTF-8` 下连字符 `-` 的权重
 *      与 C 序不同，而商品 id 全是 `p-xxx` 这种带连字符的形状：
 *      一旦两边算出不同的序，"统一取锁顺序"就只在单侧成立，跨实例又退化成 AB / BA。
 *      显式 collate 让序**不依赖库的默认配置**。
 * @limitation `collate "C"` 是按**字节/码点**排，与 JS 的 `<`（UTF-16 码元序）在
 *      **BMP 之外**的字符上不同（代理对 vs 四字节 UTF-8）。商品 id 是 ASCII 且由服务端生成，
 *      实际不会遇到；真要支持非 ASCII id，应改为在 JS 侧排序 + 逐行 UPDATE（不依赖库的 collation），
 *      而不是换一个 collation。
 *
 * @see adapters/orders.ts（incrementStock / restoreStockForOrders）；app/create-order.ts（第 6 步）
 */
/**
 * 商品 id 的**确定序**比较——只服务于取锁顺序。
 *
 * @why 不能用 `localeCompare`：它走 ICU collation，结果随 Node 构建（small-icu / full-icu）
 *      与 ICU 版本而变。两个实例对同一组 id 若算出**不同**的锁序，"统一取锁顺序"
 *      就只在单实例内成立，跨实例仍然是 AB / BA 互等（40P01）——
 *      而防死锁恰恰只在**多实例并发**时才有意义，单机测出来绿说明不了任何事。
 * @limitation 结果不符合任何自然语言的字典序（大写整体排在小写之前）；
 *              锁序不需要好看，只需要"每个进程算出同一个结果"。
 *              id 出现非 ASCII 时 codePoint 序依然确定——与 locale 无关正是选它的理由。
 */
export function compareProductIdForLock(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SQL 侧排序商品 id 时必须显式加的 collation（见文件头 @why）。
 * @why 定义成常量而不是在 SQL 里写死字面量：写死的话，"哪几处 SQL 承担了取锁顺序"
 *      只能靠 grep 一个字符串，而 grep 会命中注释（第 54 条）。用常量后，
 *      import 它的文件就是全部的取锁点，这也是将来加新路径时的检查清单。
 */
export const PRODUCT_ID_LOCK_COLLATION = 'C';
