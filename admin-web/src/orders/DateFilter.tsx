/**
 * 职责：订单列表的下单日期筛选（AJ-400，对标 §4.1「日期范围」）——全部时间 / 今天 / 近 7 天 / 近 30 天 / 自定义。
 *
 * @why 受控组件、自身无 state：选中值来自 URL（`range` / `from` / `to`），改动交给页面写回 URL，
 *      与 OrdersPage 文件头 @limitation 四"URL 是唯一真源"同口径。
 * @why 自定义用原生 `<input type="date">`：值天然是 `YYYY-MM-DD`，与契约参数同形，不需要再解析一层。
 * @limitation 日界按 JST（日期是 JST 日历日），而原生日期控件的"今天"高亮跟浏览器本地时区——
 *             出差在美国时控件高亮的"今天"可能比 JST 晚一天；预设按钮不受影响（由 list-filter 按 JST 算）。
 * @see ./list-filter.ts（DATE_PRESETS / resolveDateRange）
 */
import { DATE_PRESETS } from './list-filter.js';

export interface DateFilterValue {
  range: string;
  from: string;
  to: string;
}

export function DateFilter({
  value,
  error,
  onChange,
}: {
  value: DateFilterValue;
  /** 自定义输入有误时的提示（不发请求）。 */
  error: string;
  onChange: (next: DateFilterValue) => void;
}) {
  return (
    <div className="filters" aria-label="下单日期">
      <select
        className="input"
        aria-label="下单日期"
        value={DATE_PRESETS.some((p) => p.key === value.range) ? value.range : ''}
        onChange={(e) => onChange({ range: e.target.value, from: '', to: '' })}
      >
        {DATE_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      {value.range === 'custom' && (
        <>
          <input
            type="date"
            className="input"
            aria-label="开始日期"
            value={value.from}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
          />
          <span className="muted">至</span>
          <input
            type="date"
            className="input"
            aria-label="结束日期"
            value={value.to}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
          />
          <span className="muted">（JST，含两端）</span>
        </>
      )}
      {error !== '' && <span className="error">{error}</span>}
    </div>
  );
}
