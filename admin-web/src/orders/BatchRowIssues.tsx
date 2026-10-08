/**
 * 职责：批量发货一行的"问题"格（AJ-401）——错误（红，不提交）与警告（黄，只提示）。
 *      勾选抽屉与 CSV 预检表共用。
 * @why 抽成一个组件：两处各写一份时，哪天一边改了文案或样式类名，另一边不会有任何用例变红。
 * @limitation `showOk` 只给 CSV 预检用（逐行确认"这行能发"）；勾选抽屉每行都要填，空着不显示更清楚。
 */
import type { BatchRow } from './ship-batch.js';

export function BatchRowIssues({
  row,
  showOk = false,
}: {
  row: Pick<BatchRow, 'errors' | 'warnings'>;
  showOk?: boolean;
}): React.JSX.Element {
  return (
    <>
      {showOk && row.errors.length === 0 && row.warnings.length === 0 && (
        <span className="ok">可发货</span>
      )}
      {row.errors.map((e) => (
        <div key={e} className="error">
          {e}
        </div>
      ))}
      {row.warnings.map((w) => (
        <div key={w} className="warn">
          {w}
        </div>
      ))}
    </>
  );
}
