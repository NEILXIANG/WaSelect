/**
 * 职责：商品新建 / 编辑表单页——表单模型 → `productFormErrors` 预检 → `toProductInput` → 提交。
 *
 * @why **编辑态不重新拉单条商品**：契约没有 `GET /admin/products/{id}`
 *      （只有列表 GET、POST、PUT、PATCH status），从列表页把整条对象带过来
 *      是唯一不需要新增接口的路；多拉一次列表再 find 也一样绕。
 *      ⚠️ 代价：从别的入口进编辑页（将来若有 URL 直达）需要先补单条接口。
 *
 * @limitation 一：提交失败**保留表单**（不清空、不回列表）——
 *              十几个字段让运营重填一遍是纯粹的惩罚，而失败原因已在错误区显示。
 * @limitation 二：**不做本地草稿**（刷新即丢）。理由同 @limitation 一的反面：
 *              草稿要引入"草稿 vs 已保存"两种状态与合并规则，而商品录入是低频操作，
 *              低频 + 复杂状态不划算。
 *
 * @see ./view.ts（模型与校验真源）；./api.ts（提交与上传）；./ProductFormParts.tsx（字段组件）
 */
import { useState } from 'react';
import { ApiError } from '../api/errors.js';
import { uploadImage } from '../api/upload.js';
import { createProduct, updateProduct, type AdminApi } from './api.js';
import { productFormErrors, productFormModel, toProductInput, type ProductForm } from './view.js';
import { Field, ImagePicker, TagPicker } from './ProductFormParts.js';
import type { AdminProductLike } from './api.js';

export interface ProductFormPageProps {
  api: AdminApi;
  /** API 根地址 + 取 token（上传走独立封装，需要这两项；@see ../api/upload.ts）。 */
  baseUrl: string;
  getToken: () => string;
  /** 商品 id；null = 新建。 */
  productId: string | null;
  /** 编辑态的原始数据（列表页带过来，@see 文件头）。 */
  source: AdminProductLike | null;
  /** 完成 / 取消（回列表）。 */
  onDone: () => void;
}

export function ProductFormPage({
  api,
  baseUrl,
  getToken,
  productId,
  source,
  onDone,
}: ProductFormPageProps) {
  const [form, setForm] = useState<ProductForm>(() =>
    source === null ? productFormModel(null) : productFormModel(source),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const set = (key: keyof ProductForm, value: string | string[]) => {
    setForm((prev) => ({ ...prev, [key]: value }) as ProductForm);
    // ⚠️ 同时清掉该字段的旧错误：用户正在改它，留着旧提示等于说他还没改对
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  };

  const onSubmit = async () => {
    const result = productFormErrors(form);
    if (!result.ok) {
      setErrors(result.errors);
      setError(result.first);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body = toProductInput(form);
      if (productId === null) await createProduct(api, body);
      else await updateProduct(api, productId, body);
      onDone();
    } catch (e) {
      // @see @limitation 一：失败保留表单
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onUpload = async (file: File) => {
    setUploading(true);
    setError('');
    try {
      const imageSet = await uploadImage({ baseUrl, getToken }, file);
      setForm((prev) => ({ ...prev, images: [...prev.images, imageSet] }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">{productId === null ? '新建商品' : '编辑商品'}</h1>
        <button type="button" className="link" onClick={onDone}>
          返回列表
        </button>
      </header>

      {error !== '' && <p className="error">{error}</p>}

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <Field
          label="商品名（面向买家）"
          value={form.title}
          onChange={(v) => set('title', v)}
          error={errors['title'] ?? ''}
          placeholder="資生堂 クレンジングオイル 200ml"
        />
        <Field
          label="日文品名（采购用）"
          value={form.titleJa}
          onChange={(v) => set('titleJa', v)}
          placeholder="資生堂 クレンジングオイル"
        />
        <Field
          label="英文报关品名（必填，D-39）"
          value={form.customsDescEn}
          onChange={(v) => set('customsDescEn', v)}
          error={errors['customsDescEn'] ?? ''}
          placeholder="Cleansing oil 200ml"
        />
        <Field
          label="HS 编码（食品/化妆品建议填）"
          value={form.hsCode}
          onChange={(v) => set('hsCode', v)}
          placeholder="3304.99"
        />

        <div className="row2">
          <Field
            label="售价（円）"
            type="number"
            value={form.priceJpy}
            onChange={(v) => set('priceJpy', v)}
            error={errors['priceJpy'] ?? ''}
          />
          <Field
            label="采购成本（円，可留空）"
            type="number"
            value={form.costJpy}
            onChange={(v) => set('costJpy', v)}
            error={errors['costJpy'] ?? ''}
          />
          <Field
            label="重量（克）"
            type="number"
            value={form.weightG}
            onChange={(v) => set('weightG', v)}
            error={errors['weightG'] ?? ''}
          />
          <Field
            label="库存"
            type="number"
            value={form.stock}
            onChange={(v) => set('stock', v)}
            error={errors['stock'] ?? ''}
          />
        </div>

        <label className="field">
          <span className="label">分类</span>
          <select
            className="input"
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
          >
            <option value="beauty">美妆护肤</option>
            <option value="daily">日用杂货</option>
            <option value="kitchen">厨房餐具</option>
            <option value="food">食品</option>
          </select>
          {errors['category'] !== undefined && <span className="error">{errors['category']}</span>}
        </label>

        {/* 原产地只读：MVP 只接受 JP（D-42/D-43），让它可改只会造出必然被拒的请求 */}
        <Field
          label="原产地（MVP 固定 JP）"
          value={form.originCountry}
          onChange={() => {}}
          readOnly
        />

        <Field
          label="JAN 码"
          value={form.janCode}
          onChange={(v) => set('janCode', v)}
          placeholder="4901872071234"
        />
        <Field
          label="采购渠道"
          value={form.purchaseSource}
          onChange={(v) => set('purchaseSource', v)}
          placeholder="cosme.net"
        />
        <Field label="商品描述" value={form.description} onChange={(v) => set('description', v)} />

        <TagPicker
          value={form.tags}
          onChange={(tags) => set('tags', tags)}
          error={errors['tags'] ?? ''}
        />

        <ImagePicker
          images={form.images}
          onAdd={(file) => void onUpload(file)}
          onRemove={(i) =>
            setForm((prev) => ({ ...prev, images: prev.images.filter((_, k) => k !== i) }))
          }
          uploading={uploading}
        />

        <button type="submit" className="btn" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </form>
    </section>
  );
}
