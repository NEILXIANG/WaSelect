/**
 * 职责：商品表单的**字段级小组件**（输入行 / 合规标签勾选 / 图片选择）。
 *
 * @why 从表单页拆出来：主页要渲染十四个字段，全写在一个文件里会超过约束二的
 *      "前端 ≤150 行"，而拆分后每个组件都只有"一个输入 + 一条错误"这么大的职责。
 *
 * @limitation 一：**禁售标签仍可勾选**（勾选后由 `productFormErrors` 报错而不是禁用）：
 *      禁用它的表现是"我明明要标'含酒精'却点不动"，运营不知道为什么；
 *      让它能勾、勾了报"这些标签上架即拒"，才把规则说清楚。
 * @limitation 二：**两套标签不能用同一个组件**——合规标签是封闭枚举（芯片勾选），
 *      编辑标签是自由文案（输入 + 回车）。曾经考虑过合并成一个带 `allowCustom` 的组件，
 *      但两者除"都显示成一排小方块"之外没有共同点：一个要校验枚举、
 *      一个要处理回车/去重/空串；合并后每个分支都要判断一次参数，
 *      反而比两个各 30 行的组件难读。
 *
 * @see ./view.ts（校验真源）；packages/shared/src/enums.ts（COMPLIANCE_TAG / BLOCKED_COMPLIANCE_TAG）
 */

import { BLOCKED_COMPLIANCE_TAG, COMPLIANCE_TAG } from '@waselect/shared';
import type { ProductImageEntry } from './view.js';

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

export interface FreeTagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  /**
   * 尚未按回车的草稿（受控，A-04）：由表单持有，保存时并入 tags。
   * @why 草稿原来是组件内部状态，表单提交看不到它——打了字没按回车就点保存，标签被悄悄丢掉。
   */
  draft: string;
  onDraftChange: (draft: string) => void;
  error?: string;
}

/**
 * **编辑标签**输入（自由文案，回车添加，点 × 移除）——`products.tags`（020）。
 *
 * @why 与 `TagPicker` 分开：@see @limitation 二。
 * @why 回车**去重**且**拒绝空串**而不是照单全收：
 *      重复标签会印成两个一模一样的方块（买家读作"这个商品有两个标签"），
 *      空标签则会被服务端 `tags_invalid` 拒掉**整条请求**——
 *      运营填了十个字段，因为一个看不见的空格全部白填。
 * @limitation **不做**数量上限：契约未规定，加上限等于凭空造一条规则；
 *              真出现"一个商品三十个标签"时该改的是版式，不是这里。
 */
export function FreeTagInput({
  value,
  onChange,
  draft,
  onDraftChange: setDraft,
  error = '',
}: FreeTagInputProps) {
  const add = () => {
    const t = draft.trim();
    if (t === '' || value.includes(t)) {
      setDraft('');
      return;
    }
    onChange([...value, t]);
    setDraft('');
  };
  return (
    <div className="field">
      <span className="label">编辑标签（自由文案，印在买家看到的卡片上）</span>
      <div className="chips">
        {value.map((t) => (
          <span key={t} className="chip chip-on">
            {t}
            <button
              type="button"
              className="link"
              aria-label={`移除标签 ${t}`}
              onClick={() => onChange(value.filter((x) => x !== t))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        className="input"
        value={draft}
        placeholder="输入后按回车添加，如「南部铁器」"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // ⚠️ 必须 preventDefault：input 在 form 里，回车会**直接提交表单**，
          //    表现为"加了个标签、页面却跳回列表了"。
          // ⚠️ 输入法合成中的回车是在**确认候选词**，不是"添加"（A-09）：
          //    不排除的话，日文 / 中文输入法会把半截拼写当成标签加进去。
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            add();
          }
        }}
      />
      {error !== '' && <span className="error">{error}</span>}
    </div>
  );
}

export interface ImagePickerProps {
  /** 预览只用 `thumb`（最小的那档）；`image_id` 由提交侧负责，这里不读它。 */
  images: ProductImageEntry[];
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
