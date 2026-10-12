/**
 * 职责：危险操作前的"原因"输入框——没填时提示标在框下、光标放进去（拉黑 / 解除拉黑 / 删除行为记录共用）。
 *
 * @why 全入口点击测试 2026-10-12：原先没填原因时提示走右下角浮层，原因框在页面中部，光标不动——
 *      运营要自己找哪里没填。与全局停售（SalesPausePanel）同一做法：提示就近、聚焦。
 * @limitation 只管"空不空"；原因写得好不好（够不够事后查）仍靠 placeholder 的例子引导。
 */
import { forwardRef } from 'react';
import { ADMIN_NOTE_MAX_LENGTH } from '@waselect/shared';

export interface ReasonInputProps {
  name: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  /** 非空 = 显示在框下的提示（父组件在"没填就点"时设，填了内容自动清掉由父组件决定）。 */
  error: string;
}

export const ReasonInput = forwardRef<HTMLInputElement, ReasonInputProps>(function ReasonInput(
  { name, placeholder, value, onChange, error },
  ref,
) {
  return (
    <div className="field">
      <input
        ref={ref}
        className={error !== '' ? 'input input-error' : 'input'}
        name={name}
        placeholder={placeholder}
        maxLength={ADMIN_NOTE_MAX_LENGTH}
        value={value}
        aria-invalid={error !== '' ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error !== '' && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
});
