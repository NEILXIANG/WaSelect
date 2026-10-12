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
import { COMPLIANCE_TAG_LABELS } from './view.js';
import { UPLOAD_ACCEPT } from '../api/upload.js';
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
  /** 多行（商品描述等长文本；三端联动 UI 模拟 2026-10-08：原先描述是单行框）。 */
  multiline?: boolean;
  /** 必填：标签后统一显示「*必填」（AJ-410 / N24，原先有的写"（必填）"、有的不写）。 */
  required?: boolean;
  /** 输入框下方的一行说明（如 HS 编码是什么、去哪查，N23）。 */
  hint?: string;
  /** 错误键（= productFormErrors 的键）：生成输入框 id，顶部错误清单点一下就能跳到这里（N26）。 */
  fieldKey?: string;
}

/** 表单字段的 DOM id（顶部错误清单据此聚焦，N26）。 */
export function productFieldId(key: string): string {
  return `pf-${key}`;
}

/** 错误键 → 字段名（顶部"点一下跳过去"清单用，N26）；认不出的键原样显示。 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  title: '商品名',
  titleJa: '日文品名',
  description: '商品描述',
  editorialWhy: '为什么值得买',
  editorialMaker: '产地 / 工房 / 匠人',
  editorialTags: '编辑标签',
  category: '分类',
  priceJpy: '售价',
  costJpy: '采购成本',
  weightG: '重量',
  stock: '库存',
  customsDescEn: '英文报关品名',
  hsCode: 'HS 编码',
  originCountry: '原产地',
  complianceTags: '合规标签',
  janCode: 'JAN 码',
  purchaseSource: '采购渠道',
};

export function productFieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

/** 必填标记（N24）。 */
export function RequiredMark(): React.JSX.Element {
  return <span className="required-mark"> *必填</span>;
}

export function Field({
  label,
  value,
  onChange,
  error = '',
  type = 'text',
  placeholder = '',
  readOnly = false,
  multiline = false,
  required = false,
  hint = '',
  fieldKey,
}: FieldProps) {
  const id = fieldKey !== undefined ? productFieldId(fieldKey) : undefined;
  return (
    <label className="field">
      <span className="label">
        {label}
        {required && <RequiredMark />}
      </span>
      {multiline ? (
        <textarea
          id={id}
          className="input"
          rows={4}
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="input"
          type={type}
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint !== '' && <span className="muted">{hint}</span>}
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
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((t) => t !== tag) : [...value, tag])}
            >
              {COMPLIANCE_TAG_LABELS[tag] ?? tag}
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
        // 两端逐页走查 2026-10-12：上面的说明是 span，没和输入框关联，读屏只读出"编辑文本"
        aria-label="编辑标签"
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
  /** 一次可选多张（按选的顺序逐张上传，由页面负责，全入口点击测试 2026-10-12）。 */
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
  /** 把第 from 张挪到第 to 位（AJ-403；越界由 view.moveImage 原样返回）。 */
  onMove: (from: number, to: number) => void;
  /** 设为主图 = 挪到第一张。 */
  onMakeMain: (index: number) => void;
  uploading: boolean;
  error?: string;
}

/**
 * 图片选择：选文件 → `POST /admin/upload` → 服务端产出 thumb/card/detail 三档。
 * @why 只显示 thumb（最小的那档）：管理端列表只需确认"传的是不是这张图"，
 *      显示 detail 大图会把表单撑得很长，而信息量没有增加。
 * @why 排序用「↑ / ↓ / 设为主图」按钮而不是拖拽（AJ-403）：数组顺序即展示顺序、第一张是主图，
 *      按钮在触控板、键盘、读屏下都能用，且每一下的结果可预期；拖拽要另引库或自写命中计算。
 *      @tradeoff 十张图把最后一张挪到第二位要点多下——实际商品图在 3–6 张，「设为主图」覆盖了最常见的那一下。
 *      首尾两端的按钮**禁用**而不是隐藏：位置不跳，运营不会点到旁边那张的按钮。
 * @why 全入口点击测试 2026-10-12：图从左往右排，按钮改写 ← / →（原 ↑ / ↓ 与排列方向对不上）；缩略图用方框
 *      （原借用 Banner 的 2.5:1 横框，方图被裁成一条）；动作收成两行（原每个按钮各占一行）；「移除」用危险色；可一次选多张。
 */
export function ImagePicker({
  images,
  onAdd,
  onRemove,
  onMove,
  onMakeMain,
  uploading,
  error = '',
}: ImagePickerProps) {
  return (
    <div className="field">
      <span className="label">商品图片（{images.length} 张；第一张是主图）</span>
      <div className="thumbs">
        {images.map((img, i) => (
          <div key={`${img.image_id ?? img.thumb}-${i}`} className="thumb thumb-product">
            <img src={img.thumb} alt={`商品图 ${i + 1}`} className="thumb-img thumb-img-square" />
            <div className="thumb-actions">
              {i === 0 ? (
                <span className="chip chip-on">主图</span>
              ) : (
                <button
                  type="button"
                  className="link"
                  aria-label={`把第 ${i + 1} 张设为主图`}
                  onClick={() => onMakeMain(i)}
                >
                  设为主图
                </button>
              )}
            </div>
            <div className="thumb-actions">
              <button
                type="button"
                className="link"
                aria-label={`把第 ${i + 1} 张前移`}
                disabled={i === 0}
                onClick={() => onMove(i, i - 1)}
              >
                ←
              </button>
              <button
                type="button"
                className="link"
                aria-label={`把第 ${i + 1} 张后移`}
                disabled={i === images.length - 1}
                onClick={() => onMove(i, i + 1)}
              >
                →
              </button>
              <button type="button" className="link link-danger" onClick={() => onRemove(i)}>
                移除
              </button>
            </div>
          </div>
        ))}
      </div>
      <input
        className="input"
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        disabled={uploading}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length > 0) onAdd(files);
          // ⚠️ 清空 value：否则连续选同一个文件不会再触发 change（浏览器按"值没变"跳过）
          e.target.value = '';
        }}
      />
      {uploading && <span className="muted">上传中…</span>}
      {error !== '' && <span className="error">{error}</span>}
    </div>
  );
}
