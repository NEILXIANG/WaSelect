/**
 * 职责：商品表单的**分组卡片**（AJ-403，对标 §4.3「编辑页布局」）——主栏四组、侧栏三组。
 *
 * @why 分组按"运营录入时在想什么"而不是按数据库列：
 *      主栏 = 买家会看到的（基本信息 / 媒体 / 价格与库存）+ 报关必填（报关与合规）；
 *      侧栏 = "看一眼就定"的归类与采购信息（状态 / 分类与合规标签 / JAN 与采购渠道）。
 *      侧栏放状态卡并把提交按钮放在里面：宽屏时按钮始终在右上方可见，窄屏塌成单列时落在表单末尾。
 * @why 从 ProductFormPage 拆出来：页面只管"提交 / 冲突 / 上传"这些状态，字段摆放全在这里，
 *      改版式（约束五）不必碰提交逻辑。
 *
 * @limitation 字段组件仍是 ProductFormParts 那几个，本文件只决定**摆在哪一组**；
 *             字段标签文字被 DOM 用例按原文查找，改文字要同步用例。
 *
 * @see ./ProductFormPage.tsx；./ProductFormParts.tsx；../app.css（.product-grid / .form-card）
 */
import type { ReactNode } from 'react';
import { CATEGORY_LABELS, PRODUCT_CATEGORY, type ProductForm, titleLengthHint } from './view.js';
import {
  Field,
  FreeTagInput,
  ImagePicker,
  productFieldId,
  RequiredMark,
  TagPicker,
} from './ProductFormParts.js';

/** 一张分组卡片（标题 + 内容）。 */
export function FormCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="form-card">
      <h2 className="form-card-title">{title}</h2>
      {children}
    </section>
  );
}

export interface SectionProps {
  form: ProductForm;
  set: (key: keyof ProductForm, value: string | string[]) => void;
  errors: Record<string, string>;
}

export interface MainColumnProps extends SectionProps {
  tagDraft: string;
  onTagDraftChange: (v: string) => void;
  uploading: boolean;
  onUpload: (file: File) => void;
  onRemoveImage: (i: number) => void;
  onMoveImage: (from: number, to: number) => void;
  onMakeMain: (i: number) => void;
}

/** 主栏：基本信息 / 媒体 / 价格与库存 / 报关与合规。 */
export function ProductMainColumn(p: MainColumnProps) {
  const { form, set, errors } = p;
  return (
    <div className="product-main">
      <FormCard title="基本信息">
        <Field
          label="商品名（面向买家）"
          required
          fieldKey="title"
          value={form.title}
          onChange={(v) => set('title', v)}
          error={errors['title'] ?? ''}
          hint={titleLengthHint(form.title)}
          placeholder="例：資生堂 クレンジングオイル 200ml"
        />
        <Field
          label="日文品名（采购用）"
          fieldKey="titleJa"
          value={form.titleJa}
          onChange={(v) => set('titleJa', v)}
          error={errors['titleJa'] ?? ''}
          placeholder="例：資生堂 クレンジングオイル"
        />
        <Field
          label="商品描述"
          fieldKey="description"
          multiline
          value={form.description}
          onChange={(v) => set('description', v)}
          error={errors['description'] ?? ''}
        />
        {/* 编辑口径（020）：印在买家卡片上的内容，与侧栏的合规标签不是一回事 */}
        <Field
          label="为什么值得买（买家可见，一句带判断的话）"
          fieldKey="editorialWhy"
          value={form.editorialWhy}
          onChange={(v) => set('editorialWhy', v)}
          error={errors['editorialWhy'] ?? ''}
          placeholder="例：铸铁蓄热足，水温掉得慢——但养锅比用锅费事"
        />
        <Field
          label="产地 / 工房 / 匠人（买家可见）"
          fieldKey="editorialMaker"
          value={form.editorialMaker}
          onChange={(v) => set('editorialMaker', v)}
          error={errors['editorialMaker'] ?? ''}
          placeholder="例：岩手县 伝統工房"
        />
        <FreeTagInput
          value={form.editorialTags}
          onChange={(tags) => set('editorialTags', tags)}
          draft={p.tagDraft}
          onDraftChange={p.onTagDraftChange}
          error={errors['editorialTags'] ?? ''}
        />
      </FormCard>

      <FormCard title="媒体">
        <ImagePicker
          images={form.images}
          onAdd={p.onUpload}
          onRemove={p.onRemoveImage}
          onMove={p.onMoveImage}
          onMakeMain={p.onMakeMain}
          uploading={p.uploading}
        />
      </FormCard>

      <FormCard title="价格与库存">
        <div className="row2">
          <Field
            label="售价（日元）"
            required
            fieldKey="priceJpy"
            type="number"
            value={form.priceJpy}
            onChange={(v) => set('priceJpy', v)}
            error={errors['priceJpy'] ?? ''}
          />
          <Field
            label="采购成本（日元，可留空）"
            fieldKey="costJpy"
            type="number"
            value={form.costJpy}
            onChange={(v) => set('costJpy', v)}
            error={errors['costJpy'] ?? ''}
          />
          <Field
            label="重量（克）"
            required
            fieldKey="weightG"
            type="number"
            value={form.weightG}
            onChange={(v) => set('weightG', v)}
            error={errors['weightG'] ?? ''}
          />
          <Field
            label="库存"
            required
            fieldKey="stock"
            type="number"
            value={form.stock}
            onChange={(v) => set('stock', v)}
            error={errors['stock'] ?? ''}
          />
        </div>
      </FormCard>

      <FormCard title="报关与合规">
        <Field
          label="英文报关品名"
          required
          fieldKey="customsDescEn"
          hint="海关看的英文品名，写清是什么东西，例：Cleansing oil 200ml"
          value={form.customsDescEn}
          onChange={(v) => set('customsDescEn', v)}
          error={errors['customsDescEn'] ?? ''}
          placeholder="例：Cleansing oil 200ml"
        />
        <Field
          label="HS 编码"
          required
          fieldKey="hsCode"
          hint="海关商品编码，6–10 位数字，例：3304.99；不清楚可问采购或查日本税关网站"
          value={form.hsCode}
          onChange={(v) => set('hsCode', v)}
          error={errors['hsCode'] ?? ''}
          placeholder="例：3304.99"
        />
        {/* 原产地只读：目前只接受 JP（D-42/D-43），让它可改只会造出必然被拒的请求 */}
        <Field
          label="原产地（目前只支持日本 JP）"
          value={form.originCountry}
          onChange={() => {}}
          readOnly
        />
      </FormCard>
    </div>
  );
}

export interface SideColumnProps extends SectionProps {
  /** 状态卡的内容（当前状态 + 提交按钮），由页面给：它依赖提交状态。 */
  statusCard: ReactNode;
}

/** 侧栏：状态 / 分类与标签 / 采购。 */
export function ProductSideColumn({ form, set, errors, statusCard }: SideColumnProps) {
  return (
    <aside className="product-side">
      <FormCard title="状态">{statusCard}</FormCard>
      <FormCard title="分类与标签">
        <label className="field">
          <span className="label">
            分类
            <RequiredMark />
          </span>
          <select
            id={productFieldId('category')}
            className="input"
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
          >
            {/* ⚠️ 选项由 `PRODUCT_CATEGORY` + `CATEGORY_LABELS` 生成，不写死（ADM3-08）：
                写死时契约新增分类后受控 select 的 value 不在选项里，浏览器显示第一项、state 里却是新分类。 */}
            {PRODUCT_CATEGORY.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          {errors['category'] !== undefined && <span className="error">{errors['category']}</span>}
        </label>
        <TagPicker
          value={form.complianceTags}
          onChange={(tags) => set('complianceTags', tags)}
          error={errors['complianceTags'] ?? ''}
        />
      </FormCard>
      <FormCard title="采购">
        <Field
          label="JAN 码"
          fieldKey="janCode"
          value={form.janCode}
          onChange={(v) => set('janCode', v)}
          error={errors['janCode'] ?? ''}
          placeholder="例：4901872071234"
        />
        <Field
          label="采购渠道"
          fieldKey="purchaseSource"
          value={form.purchaseSource}
          onChange={(v) => set('purchaseSource', v)}
          error={errors['purchaseSource'] ?? ''}
          placeholder="例：cosme.net"
        />
      </FormCard>
    </aside>
  );
}
