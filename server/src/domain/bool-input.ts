/**
 * 职责：**可选布尔输入**的判定（AJ-353）——"没传"与"传了但不是布尔"必须分开。
 *
 * @why 抽成一个纯函数而不是在两处各写一遍：原来的写法是 `x['active'] !== false`，
 *      它同时出现在 `shipping-rates-input.ts` 与 `banner-input.ts`，两处配着同一句
 *      "缺省启用"。而这句"缺省"掩盖了另一半语义——**除了字面 `false` 之外一切都启用**：
 *      `"false"`（字符串）、`0`、`null`、`"no"`、`[]` 全部被当成 `true`。
 *      两份实现必然漂移（ADR-29：同一个判断的第二份实现就是漂移的起点）。
 *
 * @why 🔴 "传了但类型不对"必须**报错**而不是落回缺省：
 *      它和"没传"的后果正好相反——没传是"我不管，用默认"；传了 `"false"` 是
 *      "**我要停用**"。静默当成默认等于把"我要停用"执行成"启用"，
 *      而这两处都是**静默失效**的现场：
 *        · 运费档：该停用的档位照常参与 `catalog.findShippingPriceJpy` 的取档 ⇒
 *          包裹可能取到另一个价，**运费算错且没有任何一方报错**（D-46 同类：错了还静默）；
 *        · Banner：该停用的 banner 照常出现在买家首页 `GET /home`。
 *      两者都不会有 4xx、不会有日志，只有人眼看见才发现。
 *      CSV / Excel 导入是最容易产出 `"false"` 的入口（数字与字符串列型由工具决定）。
 *
 * @why `null` 与"没传"**同义**，都取缺省值：JSON 里 `null` 的通行含义就是"这一项没有"，
 *      把它判成类型错会让"清空表单项"（前端把值置 null）这种合法动作被拒。
 *      与 `product-input.ts` 的 `isBlank` 同口径（AJ-352）。
 *
 * @limitation 只判**类型**，不判"这个值业务上允不允许"：调用方若要求必须显式传，
 *      自己在外面判 undefined（本函数不管缺省值该不该存在）。
 *
 * @see server/src/domain/shipping-rates-input.ts（`active`）；
 *      server/src/domain/banner-input.ts（`active`）；
 *      contracts/api-contract.yaml（两处 `active: {type: boolean, default: true}`）
 */

/**
 * @param raw 原始值（未归一化）。
 * @param field 字段名（用于 reason 的 `<field>_invalid`；与契约键名一致）。
 * @param fallback 没传（`undefined` / `null`）时的取值。
 * @param onInvalid 类型不对时由调用方抛出——错误码与 details 是调用方的事
 *      （运费要带 `index`，Banner 不带），本文件不替它决定。
 * @returns 布尔。
 */
export function optionalBool(
  raw: unknown,
  field: string,
  fallback: boolean,
  onInvalid: (reason: string) => never,
): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') onInvalid(`${field}_invalid`);
  return raw;
}
