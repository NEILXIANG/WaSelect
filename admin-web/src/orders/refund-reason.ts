/**
 * 职责：退款原因 = 预设 + 补充说明，拼成服务端要的那一个 `reason` 字符串（AJ-400，对标 §4.4 P1）。
 *
 * @why 预设（缺货 / 破损 / 错发 / 买家取消 / 其它）是为了**事后能统计**：自由文本里"缺货""没货""断货"
 *      是三种写法，按原因数退款笔数就只能人肉读。拼成 `缺货：补充说明` 的固定前缀，
 *      导出或审计页按"："前的那段分组即可，**服务端与契约都不用改**（`reason` 仍是一个字符串）。
 * @why 长度按**拼好之后**的整串校验，上限仍是 shared `REFUND_REASON_MAX_LENGTH`：
 *      服务端只认整串（超了 40001，全额退款还会卡在退款中，见 limits.ts），前端单查补充说明会少算前缀那几个字。
 * @tradeoff 预设必选（不选不让提交）：放行"不选预设只写自由文本"会让统计里永远有一类"未分类"，
 *           代价是运营多点一下；真正说不清的走「其它」+ 必填说明。
 * @limitation 预设词表（现在 shared）：改词只影响以后的退款，历史记录的前缀不会跟着变（统计时要认旧词）；
 *             「缺货」还决定落定时回不回补库存（AJ-427），改名前先看 shared/refund-reason.ts。
 * @see ../../../packages/shared/src/limits.ts（REFUND_REASON_MAX_LENGTH）；./RefundReasonField.tsx
 */
import {
  REFUND_REASON_MAX_LENGTH,
  REFUND_REASON_PRESETS,
  REFUND_REASON_SEPARATOR,
} from '@waselect/shared';

// 词表上移到 shared（AJ-427：服务端落定时要认「缺货」）；这里转出，调用方不用改 import
export { REFUND_REASON_PRESETS };

/** 必须写补充说明的预设。 */
const NOTE_REQUIRED = '其它';

export interface RefundReasonInput {
  /** 预设之一；'' = 还没选。 */
  preset: string;
  /** 补充说明（选填；「其它」必填）。 */
  note: string;
}

export function emptyRefundReason(): RefundReasonInput {
  return { preset: '', note: '' };
}

/** 预设 + 说明 → 提交用的 reason；不合格时给出可直接展示的提示。 */
export function composeRefundReason(
  input: RefundReasonInput,
): { ok: true; reason: string } | { ok: false; error: string } {
  if (!(REFUND_REASON_PRESETS as readonly string[]).includes(input.preset)) {
    return { ok: false, error: '请选择退款原因' };
  }
  const note = input.note.trim();
  if (input.preset === NOTE_REQUIRED && note === '') {
    return { ok: false, error: '选「其它」时请写明原因' };
  }
  const reason = note === '' ? input.preset : `${input.preset}${REFUND_REASON_SEPARATOR}${note}`;
  if (reason.length > REFUND_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `退款原因（含预设前缀）不得超过 ${String(REFUND_REASON_MAX_LENGTH)} 字（当前 ${String(reason.length)} 字）`,
    };
  }
  return { ok: true, reason };
}
