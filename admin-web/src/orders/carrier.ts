/**
 * 职责：承运商**下拉选项**（AJ-410 / N18）——单单发货、批量发货、导入运单号三处共用。
 *
 * @why 原先承运商是自由文本框，新手不知道填什么（"EMS？日本邮政？Japan Post？"），写法五花八门。
 *      本店目前实际只走日本邮便 EMS，所以给它一个默认项；其余情况选「其他（手动填写）」再打字——
 *      仍是自由文本，服务端不认承运商枚举（契约 `carrier` 是 string），不新增服务端约束。
 * @why 提交的值是 `Japan Post EMS`（不带中文括注）：它是发货邮件里给美国买家看的；
 *      `isJapanPostCarrier` 认得它（整词 japan post），形状警告与查件链接照常生效。
 * @limitation 选项写在这里而不是配置表：承运商还只有一家，为一个下拉建表换不来东西；接第二家时再改成配置驱动（约束四）。
 */
export const CARRIER_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'Japan Post EMS', label: 'Japan Post EMS（日本邮政）' },
];

/** 默认承运商（单单发货打开时、批量发货没有"上一次用过的"时）。 */
export const DEFAULT_CARRIER = CARRIER_PRESETS[0]?.value ?? '';

/** 下拉里「其他（手动填写）」那一项的值（不会被提交）。 */
export const OTHER_CARRIER = '__other__';

/** 当前承运商 → 下拉应选中的项：是预设就选它，否则选「其他」并把原值放进旁边的文本框。 */
export function carrierChoice(carrier: string): string {
  return CARRIER_PRESETS.some((p) => p.value === carrier) ? carrier : OTHER_CARRIER;
}
