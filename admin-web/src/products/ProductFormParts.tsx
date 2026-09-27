/**
 * 职责：商品表单的**字段级小组件**（输入行 / 合规标签勾选 / 图片选择）。
 *
 * @why 从表单页拆出来：主页要渲染十四个字段，全写在一个文件里会超过约束二的
 *      "前端 ≤150 行"，而拆分后每个组件都只有"一个输入 + 一条错误"这么大的职责。
 *
 * @limitation 一：**禁售标签仍可勾选**（勾选后由 `productFormErrors` 报错而不是禁用）：
 *      禁用它的表现是"我明明要标'含酒精'却点不动"，运营不知道为什么；
 *      让它能勾、勾了报"这些标签上架即拒"，才把规则说清楚。
 *
 * @see ./view.ts（校验真源）；packages/shared/src/enums.ts（COMPLIANCE_TAG / BLOCKED_COMPLIANCE_TAG）
 */
import { BLOCKED_COMPLIANCE_TAG, COMPLIANCE_TAG } from '@waselect/shared';

export interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** 错误文案（空串 = 无错误）。 */
  error?: string;
  /** 输入类型；数值字段用 `number`（移动端弹数字键盘）。 */
  type?: 'text' | 'number';
  placeholder?: string;
  /** 只读（用于 MVP 固定值，如原产地 JP）。 */
  readOnly?: boolean;
}

export function Field({
  label,
  value,
  onChange,
  error = '',
  type = 'text',
  placeholder = '',
  readOnly = false,
}: FieldProps) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <input
        className="input"
        type={type}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
      {error !== '' && <span className="error">{error}</span>}
    </label>
  );
}

export interface TagPickerProps {
  value: string[];
  onChange: (tags: string[]) => void;
  error?: string;
}

/** 合规标签勾选（@see @limitation 一：禁售标签可勾但会报错）。 */
export function TagPicker({ value, onChange, error = '' }: TagPickerProps) {
  const blocked = BLOCKED_COMPLIANCE_TAG as readonly string[];
  return (
    <div className="field">
      <span className="label">合规标签（用于运输与申报判定）</span>
      <div className="chips">
        {COMPLIANCE_TAG.map((tag) => {
          const on = value.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              className={on ? 'chip chip-on' : 'chip'}
              onClick={() => onChange(on ? value.filter((t) => t !== tag) : [...value, tag])}
            >
              {tag}
              {blocked.includes(tag) ? '（禁售）' : ''}
            </button>
          );
        })}
      </div>
      {error !== '' && <span className="error">{error}</span>}
    </div>
  );
}

export interface ImagePickerProps {
  images: Array<{ thumb: string; card: string; detail: string }>;
  onAdd: (file: File) => void;
  onRemove: (index: number) => void;
  uploading: boolean;
  error?: string;
}

/**
 * 图片选择：选文件 → `POST /admin/upload` → 服务端产出 thumb/card/detail 三档。
 * @why 只显示 thumb（最小的那档）：管理端列表只需确认"传的是不是这张图"，
 *      显示 detail 大图会把表单撑得很长，而信息量没有增加。
 */
export function ImagePicker({ images, onAdd, onRemove, uploading, error = '' }: ImagePickerProps) {
  return (
    <div className="field">
      <span className="label">商品图片（{images.length} 张）</span>
      <div className="thumbs">
        {images.map((img, i) => (
          <div key={`${img.thumb}-${i}`} className="thumb">
            <img src={img.thumb} alt={`商品图 ${i + 1}`} className="thumb-img" />
            <button type="button" className="link" onClick={() => onRemove(i)}>
              移除
            </button>
          </div>
        ))}
      </div>
      <input
        className="input"
        type="file"
        accept="image/*"
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file !== undefined) onAdd(file);
          // ⚠️ 清空 value：否则连续选同一个文件不会再触发 change（浏览器按"值没变"跳过）
          e.target.value = '';
        }}
      />
      {uploading && <span className="muted">上传中…</span>}
      {error !== '' && <span className="error">{error}</span>}
    </div>
  );
}
