/**
 * 职责：退款原因输入（预设下拉 + 补充说明），全额退款与部分退款两张表单共用（AJ-400）。
 *
 * @why 一个组件两处用：两张表单各写一份下拉，预设词表迟早漂成两套，统计就对不上。
 * @limitation 只管输入，不管校验与拼接——那在 ./refund-reason.ts（纯函数，有单测）。
 */
import { REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import { REFUND_REASON_PRESETS, type RefundReasonInput } from './refund-reason.js';

export function RefundReasonField({
  value,
  onChange,
  noteName,
}: {
  value: RefundReasonInput;
  onChange: (next: RefundReasonInput) => void;
  /** 补充说明输入框的 name（测试与表单定位用）。 */
  noteName?: string;
}) {
  return (
    <>
      {/* AJ-410：真标签在上方（原先只有下拉第一项与占位灰字说明这一格是什么） */}
      <label className="field">
        <span className="label">退款原因（会记录下来）</span>
        <select
          className="input"
          aria-label="退款原因"
          value={value.preset}
          onChange={(e) => onChange({ ...value, preset: e.target.value })}
        >
          <option value="">请选择退款原因</option>
          {REFUND_REASON_PRESETS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="label">
          {value.preset === '其它' ? '补充说明（必填）' : '补充说明（选填）'}
        </span>
        <input
          className="input"
          {...(noteName !== undefined ? { name: noteName } : {})}
          placeholder="例：买家收到时外盒破损"
          // 整串上限另由 composeRefundReason 按"预设：说明"算；这里只挡住明显超长的粘贴
          maxLength={REFUND_REASON_MAX_LENGTH}
          value={value.note}
          onChange={(e) => onChange({ ...value, note: e.target.value })}
        />
      </label>
    </>
  );
}
