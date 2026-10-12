/**
 * 职责：退款原因输入（预设下拉 + 补充说明），全额退款与部分退款两张表单共用（AJ-400）。
 *
 * @why 一个组件两处用：两张表单各写一份下拉，预设词表迟早漂成两套，统计就对不上。
 * @limitation 只管输入，不管校验与拼接——那在 ./refund-reason.ts（纯函数，有单测）。
 * @why 选「缺货」时就地说明不回补库存（AJ-427）：服务端落定时按这个预设跳过回补，运营要在点之前知道，
 *      不然会以为库存"自动还回去了"。两张表单共用这一句，部分退款（累计退满时才回补）同样适用。
 */
import { OUT_OF_STOCK_REFUND_PRESET, REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import { REFUND_REASON_PRESETS, type RefundReasonInput } from './refund-reason.js';

export function RefundReasonField({
  value,
  onChange,
  noteName,
  error = '',
}: {
  value: RefundReasonInput;
  onChange: (next: RefundReasonInput) => void;
  /** 补充说明输入框的 name（测试与表单定位用）。 */
  noteName?: string;
  /** 非空 = 标在原因框下的提示（规律排查 2026-10-12：原先全额退款的提示只进浮层）。 */
  error?: string;
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
      {error !== '' && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {value.preset === OUT_OF_STOCK_REFUND_PRESET && (
        <p className="muted">
          选「缺货」不会把库存加回去（货本来就没有）；若之后补到货，请到「商品管理」改库存。
        </p>
      )}
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
