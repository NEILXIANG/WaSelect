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
 * @why 40914（编辑期间被别人改过）**不再让人"返回列表重进"**（P2-44）：那样会丢掉整张表单与已传的图。
 *      现在原地保留表单，给「加载最新值对照」：取最新一版只读摆在旁边（逐字段标出不同），
 *      并把版本凭据换成最新一版——运营核对后再点保存，就是"看过对方改动之后，用我的内容覆盖"。
 *
 * @see ./view.ts（模型与校验真源）；./api.ts（提交与上传）；./ProductFormParts.tsx（字段组件）
 */
import { useState } from 'react';
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';
import { uploadImage } from '../api/upload.js';
import { createProduct, findProductById, updateProduct, type AdminApi } from './api.js';
import {
  CATEGORY_LABELS,
  PRODUCT_CATEGORY,
  productConflictRows,
  productFormErrors,
  productFormSummary,
  productFormModel,
  productFormWarnings,
  sourceUpdatedAt,
  toProductInput,
  type ProductForm,
} from './view.js';
import { Field, FreeTagInput, ImagePicker, TagPicker } from './ProductFormParts.js';
import { useFormDirty } from '../ui/unsaved.js';
import type { AdminProductLike } from './api.js';

export interface ProductFormPageProps {
  api: AdminApi;
  /** API 根地址 + 取 token（上传走独立封装，需要这两项；@see ../api/upload.ts）。 */
  baseUrl: string;
  getToken: () => string;
  /** 上传遇 40101 时的出口（与通用封装同一语义：清 token 回登录页，KD-13）。 */
  onUnauthorized?: (() => void) | undefined;
  /** 商品 id；null = 新建。 */
  productId: string | null;
  /** 编辑态的原始数据（列表页带过来，@see 文件头）。 */
  source: AdminProductLike | null;
  /** 完成 / 取消（回列表）。 */
  /** 结束编辑；`message` 非空 = 保存成功的提示（列表页顶部显示一次，三端联动 UI 模拟 2026-10-08）。 */
  onDone: (message?: string) => void;
}

export function ProductFormPage({
  api,
  baseUrl,
  getToken,
  onUnauthorized,
  productId,
  source,
  onDone,
}: ProductFormPageProps) {
  const [form, setForm] = useState<ProductForm>(() =>
    source === null ? productFormModel(null) : productFormModel(source),
  );
  /**
   * 「未改动基线」：打开这一刻的模型。
   * @why 脏态不能拿 source 现算——`source` 是列表页带来的那一版，
   *      而"加载最新值对照"之后表单会被换成别的内容，两者不该混为一谈。
   *      保存成功后也要跟着更新（下面 `setPristine` 的调用点），否则保存完仍被判为"未保存"。
   */
  const [pristine, setPristine] = useState<ProductForm>(() =>
    source === null ? productFormModel(null) : productFormModel(source),
  );
  // 打开编辑页那一刻的库存：保存时只有它被改动了才提交 stock（toProductInput @see AJ-175）
  // ⚠️ 可更新：「加载最新值对照」后要换成最新库存（三端联动实测 2026-10-08）——它是 expected_stock 的来源，
  //    不换的话核对后再保存仍带打开时的旧库存，服务端永远 40914，运营只能退出重进。
  const [originalStock, setOriginalStock] = useState<string | undefined>(() =>
    source === null ? undefined : productFormModel(source).stock,
  );
  // 打开编辑页那一刻的版本凭据：保存时随 PUT 一起发，服务端据它判定"你改的是不是最新一版"
  // （ADM3-02 / 契约 0.6.18；不带上服务端直接 40001，不会静默覆盖别人的改动）
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string>(() =>
    source === null ? '' : sourceUpdatedAt(source),
  );
  /** 40914 后进入冲突态；`latest` = 载入的最新一版（只读对照，P2-44）。 */
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<AdminProductLike | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** 编辑标签框里尚未按回车的草稿（A-04：保存时并入 tags，不悄悄丢掉）。 */
  const [tagDraft, setTagDraft] = useState('');

  /** 标签草稿尚未并回 `form`（点了保存才算数），所以它单独算一份脏。 */
  useFormDirty({ form, tagDraft: tagDraft.trim() }, { form: pristine, tagDraft: '' });

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
    // 图片还在上传时不能保存（A-08）：否则商品建好了却不带这张图，存储里多一套孤儿对象
    if (uploading) return;
    // 标签草稿并入（A-04）：打了字没按回车就点保存，本意就是要这个标签
    const pending = tagDraft.trim();
    const submitted =
      pending !== '' && !form.editorialTags.includes(pending)
        ? { ...form, editorialTags: [...form.editorialTags, pending] }
        : form;
    if (submitted !== form) {
      setForm(submitted);
      setTagDraft('');
    }
    const result = productFormErrors(submitted);
    if (!result.ok) {
      setErrors(result.errors);
      // ⚠️ 顶部不重复第一条原文：每条的详情已在对应输入框下方显示，
      //    再写一遍「商品名必填」会让同一句在同一屏出现两次（见 productFormSummary 的 @why）
      setError(productFormSummary(result.errors, result.first));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body = toProductInput(submitted, productId === null ? undefined : originalStock);
      if (productId === null) {
        await createProduct(api, body);
      } else {
        // ⚠️ 拿不到凭据时**就地拦下**给一句明白话，而不是发出去等服务端 40001：
        //    "缺 updated_at"的 40001 与"报关品名不合法"的 40001 在运营眼里是同一句
        //    "请求参数不合法"，他会去改品名、改十遍也改不对（@limitation 一：服务端字段级错误不透传）。
        if (expectedUpdatedAt === '') {
          setError('缺少商品版本信息（updated_at）：请返回列表重新进入编辑，再保存');
          return;
        }
        await updateProduct(api, productId, body, expectedUpdatedAt);
      }
      // ⚠️ 保存成功后必须同步基线：表单已提交，它不再是"未保存的改动"
      //    （不同步的话，点侧栏还会被"未保存提醒"拦一次——而刚保存完显然该放行）
      setPristine(submitted);
      onDone(
        productId === null
          ? `已创建「${submitted.title.trim()}」`
          : `已保存「${submitted.title.trim()}」`,
      );
    } catch (e) {
      // @see @limitation 一：失败保留表单
      setError(e instanceof ApiError ? e.message : String(e));
      // 40914：表单**没被清**；下一步是"加载最新值对照"，而不是回列表（那会丢掉表单，P2-44）
      if (e instanceof ApiError && e.code === 40914) {
        setConflict(true);
        setLatest(null);
        setError(
          `${e.message}：你填的内容都还在。请点「加载最新值对照」看对方改了什么，核对后再保存`,
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const loadLatest = async (): Promise<void> => {
    if (productId === null) return;
    setLoadingLatest(true);
    try {
      const fresh = await findProductById(api, productId);
      if (fresh === null) {
        setError('在商品列表里找不到这条商品（可能已被删除）：你填的内容还在，可复制留存');
        return;
      }
      setLatest(fresh);
      // 换成最新一版的凭据：之后保存 = 看过对方改动后，用你的内容覆盖最新一版
      setExpectedUpdatedAt(sourceUpdatedAt(fresh));
      // 库存凭据同步换成最新值：之后保存 = "看过最新库存后，用我填的数覆盖"（与上一行同一语义）
      setOriginalStock(productFormModel(fresh).stock);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoadingLatest(false);
    }
  };

  const onUpload = async (file: File) => {
    setUploading(true);
    setError('');
    try {
      const imageSet = await uploadImage({ baseUrl, getToken, onUnauthorized }, file);
      // 商品图**存**的是 `image_id`（0.6.29 / AJ-362）——业务表不存存储位置；
      // 三档 URL 只留在表单里做**预览**与"移除"按钮的缩略图。
      // ⚠️ 所以三档 URL 仍必须拿到：拿不到就意味着编辑页看不见这张图
      //    （存储侧是成功的，但运营会以为上传失败而反复重传）。
      // ⚠️ 先解构再判空：直接在闭包里读 imageSet.thumb 拿不到这里的判空收窄（TS 在回调内失效）。
      const { thumb, card, detail, image_id } = imageSet;
      if (thumb === undefined || card === undefined || detail === undefined) {
        throw new ApiError(
          NETWORK_ERROR_CODE,
          '服务端未配置 IMG_BASE_URL：上传成功但没有可展示的 URL（商品图已存下 id，但编辑页预览不了）',
          '',
        );
      }
      // ⚠️ 提交时**只发 image_id**、不带三档 URL：服务端把"id + 三档 URL"判为混填并拒
      //    （AJ-361）。丢 URL 这一步在 `toProductInput` 里做，这里保留它们只为预览。
      setForm((prev) => ({
        ...prev,
        images: [...prev.images, { image_id, thumb, card, detail }],
      }));
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
        <button type="button" className="link" onClick={() => onDone()}>
          返回列表
        </button>
      </header>

      {error !== '' && <p className="error">{error}</p>}

      {conflict && latest === null && (
        <button
          type="button"
          className="btn"
          disabled={loadingLatest}
          onClick={() => void loadLatest()}
        >
          {loadingLatest ? '加载中…' : '加载最新值对照'}
        </button>
      )}
      {latest !== null && (
        <div className="field">
          <span className="label">
            最新一版（只读）与你填的对照：标 ≠
            的是不同项。核对后点「保存」将用你填的内容覆盖最新一版。
          </span>
          <table className="table">
            <thead>
              <tr>
                <th>字段</th>
                <th>你填的</th>
                <th>最新值</th>
              </tr>
            </thead>
            <tbody>
              {productConflictRows(form, latest).map((r) => (
                <tr key={r.label} className={r.differs ? 'error' : undefined}>
                  <td>
                    {r.differs ? '≠ ' : ''}
                    {r.label}
                  </td>
                  <td>{r.mine}</td>
                  <td>{r.latest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {productFormWarnings(form).map((w) => (
        <p className="muted" key={w}>
          ⚠️ {w}
        </p>
      ))}

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
          label="HS 编码（必填）"
          value={form.hsCode}
          onChange={(v) => set('hsCode', v)}
          error={errors['hsCode'] ?? ''}
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
            {/* ⚠️ 选项由 `PRODUCT_CATEGORY` + `CATEGORY_LABELS` 生成，不写死四个 `<option>`（ADM3-08）：
                写死时，契约新增分类后 view 层的"与契约 enum 双向比对"会红并被修好，
                而这个下拉不会跟着变——编辑新分类的商品时，受控 select 的 value 不在选项里，
                浏览器显示**第一项**、state 里却仍是新分类。运营看到的分类是错的，
                他若手动选回第一项，就真的把商品改错了（约束五：文案走配置）。 */}
            {PRODUCT_CATEGORY.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
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
        <Field
          label="商品描述"
          multiline
          value={form.description}
          onChange={(v) => set('description', v)}
        />

        {/* ── 编辑口径（020）：印在买家卡片上的内容，与下面的合规标签不是一回事 ── */}
        <Field
          label="为什么值得买（买家可见，一句带判断的话）"
          value={form.editorialWhy}
          onChange={(v) => set('editorialWhy', v)}
          error={errors['editorialWhy'] ?? ''}
          placeholder="铸铁蓄热足，水温掉得慢——但养锅比用锅费事"
        />
        <Field
          label="产地 / 工房 / 匠人（买家可见）"
          value={form.editorialMaker}
          onChange={(v) => set('editorialMaker', v)}
          error={errors['editorialMaker'] ?? ''}
          placeholder="岩手县 伝統工房"
        />
        <FreeTagInput
          value={form.editorialTags}
          onChange={(tags) => set('editorialTags', tags)}
          draft={tagDraft}
          onDraftChange={setTagDraft}
          error={errors['editorialTags'] ?? ''}
        />

        <TagPicker
          value={form.complianceTags}
          onChange={(tags) => set('complianceTags', tags)}
          error={errors['complianceTags'] ?? ''}
        />

        <ImagePicker
          images={form.images}
          onAdd={(file) => void onUpload(file)}
          onRemove={(i) =>
            setForm((prev) => ({ ...prev, images: prev.images.filter((_, k) => k !== i) }))
          }
          uploading={uploading}
        />

        <button type="submit" className="btn" disabled={saving || uploading}>
          {saving ? '保存中…' : uploading ? '图片上传中…' : '保存'}
        </button>
      </form>
    </section>
  );
}
