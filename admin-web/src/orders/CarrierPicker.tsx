/**
 * 职责：承运商选择（下拉 + 「其他」时的文本框）——单单发货、批量发货的"统一承运商"、导入运单号的默认承运商共用（AJ-410 / N18）。
 * @see ./carrier.ts（选项与默认值）
 * @limitation 选「其他」后文本框是空的、并自动获得焦点；切回预设会丢掉刚打的字（预设本身就是完整值）。
 */
import { useEffect, useRef, useState } from 'react';
import { SHIP_MAX_CHARS } from '@waselect/shared';
import { CARRIER_PRESETS, carrierChoice, OTHER_CARRIER } from './carrier.js';

export function CarrierPicker({
  id,
  value,
  onChange,
  invalid = false,
  autoFocus = false,
}: {
  /** 下拉的 id（给上方 `<label htmlFor>` 用）。 */
  id: string;
  value: string;
  onChange: (carrier: string) => void;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  // 选了「其他」但还没打字时 value 是 ''，仍要停在「其他」——所以选项单独记一份
  const [other, setOther] = useState(() => carrierChoice(value) === OTHER_CARRIER);
  const choice = other ? OTHER_CARRIER : carrierChoice(value);
  const text = useRef<HTMLInputElement | null>(null);
  const [focusText, setFocusText] = useState(false);
  useEffect(() => {
    if (focusText) text.current?.focus();
  }, [focusText]);

  return (
    <>
      <select
        id={id}
        className={`input${invalid && choice !== OTHER_CARRIER ? ' input-error' : ''}`}
        value={choice}
        autoFocus={autoFocus}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OTHER_CARRIER) {
            setOther(true);
            setFocusText(true);
            onChange('');
          } else {
            setOther(false);
            setFocusText(false);
            onChange(v);
          }
        }}
      >
        {CARRIER_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        <option value={OTHER_CARRIER}>其他（手动填写）</option>
      </select>
      {choice === OTHER_CARRIER && (
        <input
          ref={text}
          className={`input${invalid ? ' input-error' : ''}`}
          aria-label="承运商名称"
          name="carrier"
          placeholder="例：Yamato Transport"
          maxLength={SHIP_MAX_CHARS.carrier}
          value={value}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </>
  );
}
