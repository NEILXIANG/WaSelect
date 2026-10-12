/**
 * 职责：商品新建 / 编辑表单页——表单模型 → `productFormErrors` 预检 → `toProductInput` → 提交。
 *
 * @why **编辑态不重新拉单条商品**：契约没有 `GET /admin/products/{id}`
 *      （只有列表 GET、POST、PUT、PATCH status），从列表页把整条对象带过来
 *      是唯一不需要新增接口的路；多拉一次列表再 find 也一样绕。
 *      ⚠️ 代价：从别的入口进编辑页（将来若有 URL 直达）需要先补单条接口。
 *
 * @limitation 一：提交失败**保留表单**（不清空、不回列表）——
 *              十几个字段让运营重填一遍是纯粹的惩罚，而失败原因已在右下角的错误提示里（Toast，恒停留）。
 * @limitation 二：**不做本地草稿**（刷新即丢）。理由同 @limitation 一的反面：
 *              草稿要引入"草稿 vs 已保存"两种状态与合并规则，而商品录入是低频操作，
 *              低频 + 复杂状态不划算。
 *
 * @why 40914（编辑期间被别人改过）**不再让人"返回列表重进"**（P2-44）：那样会丢掉整张表单与已传的图。
 *      现在原地保留表单，给「加载最新值对照」：取最新一版只读摆在旁边（逐字段标出不同），
 *      并把版本凭据换成最新一版——运营核对后再点保存，就是"看过对方改动之后，用我的内容覆盖"。
 *
 * @why 草稿（AJ-403）：新建只给「保存为草稿 / 保存并上架」两个按钮，没有含糊的"保存"——
 *      服务端恒建草稿（契约 0.6.46），「保存并上架」= 保存后再打一次 `PATCH /status → active`
 *      （上架判定 40918 只在那一处）。第二步失败时商品**已作为草稿存下**：页面留在原地、转为编辑态
 *      （用 POST / PUT 回来的整行换版本凭据），运营改好再点一次即可，不会重复建一条。
 *      编辑**在售**商品只有「保存」：上下架仍在列表页（这里再放一个下架按钮，会和保存的乐观锁凭据打架）。
 *
 * @limitation 三：页面级反馈（校验汇总、保存 / 上架 / 上传 / 取最新值的失败）走 `ui/Toast`（审查 2026-10-09，
 *              ui/adoption 欠账清单）；字段级错误仍在各自输入框下方，顶部「点一下跳过去」的字段清单与
 *              冲突对照表（「加载最新值对照」）照旧留在页面里——它们是要操作的东西，不是提示。
 *              保存成功的提示仍由 `onDone(message)` 带回列表页、在那里走 Toast。
 *
 * @see ./view.ts（模型与校验真源）；./api.ts（提交与上传）；./ProductFormParts.tsx（字段组件）；
 *      ./ProductFormSections.tsx（分组卡片与双栏布局）
 */
import { useCategories } from '../categories/useCategories.js';
import { categoryName, categoryOptions } from '../categories/view.js';
import { useState } from 'react';
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { uploadImage } from '../api/upload.js';
import {
  createProduct,
  findProductById,
  setProductStatus,
  updateProduct,
  type AdminApi,
} from './api.js';
import {
  makeMainImage,
  moveImage,
  productConflictRows,
  productFormErrors,
  productFormSummary,
  productFormModel,
  productFormWarnings,
  sourceUpdatedAt,
  STATUS_LABELS,
  toProductInput,
  type ProductForm,
  type ProductStatus,
  serverFieldError,
} from './view.js';
import { ProductMainColumn, ProductSideColumn } from './ProductFormSections.js';
import { productFieldId, productFieldLabel } from './ProductFormParts.js';
import { useFormDirty, useUnsaved } from '../ui/unsaved.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { LEAVE_UNSAVED_SPEC } from '../ui/leave-spec.js';
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
  // AJ-491：分类来自后台分类列表（下拉选项与冲突对照里的名称）
  const { list: categories } = useCategories(api);
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
  /** 页面级反馈出口（原页面顶部那行红字）。 */
  const sink = useToasts();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** 编辑标签框里尚未按回车的草稿（A-04：保存时并入 tags，不悄悄丢掉）。 */
  const [tagDraft, setTagDraft] = useState('');
  /**
   * 新建后"上架失败"留在本页时拿到的商品 id（AJ-403）：此后本页按**编辑态**工作，
   * 再保存走 PUT 而不是再 POST 一条（否则每重试一次就多一件重复商品）。
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const editId = productId ?? createdId;
  /** 当前状态（状态卡显示用；新建未保存为 null）。 */
  const [status, setStatus] = useState<ProductStatus | null>(() => statusOf(source));

  /** 标签草稿尚未并回 `form`（点了保存才算数），所以它单独算一份脏。 */
  useFormDirty({ form, tagDraft: tagDraft.trim() }, { form: pristine, tagDraft: '' });
  // 页头「返回列表」不经 App 的 leave()（编辑态不进网址），脏态拦截要在这里自己做（审查 2026-10-09 #1）
  const { dirty } = useUnsaved();
  const [leaveAsk, setLeaveAsk] = useState(false);

  const set = (key: keyof ProductForm, value: string | string[]) => {
    setForm((prev) => ({ ...prev, [key]: value }) as ProductForm);
    // ⚠️ 同时清掉该字段的旧错误：用户正在改它，留着旧提示等于说他还没改对
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  };

  /** @param publish true = 保存后再上架（「保存并上架」）。 */
  const onSubmit = async (publish: boolean) => {
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
      // ⚠️ 顶部不重复第一条原文：每条的详情已在对应输入框下方显示（见 productFormSummary 的 @why）
      sink.error(productFormSummary(result.errors, result.first));
      return;
    }
    const wasNew = editId === null;
    const title = submitted.title.trim();
    setSaving(true);
    sink.error('');
    try {
      const body = toProductInput(submitted, wasNew ? undefined : originalStock);
      let id: string;
      let row: AdminProductLike;
      if (wasNew) {
        row = await createProduct(api, body);
        id = row.id;
        setCreatedId(id);
      } else {
        // ⚠️ 拿不到凭据时**就地拦下**给一句明白话，而不是发出去等服务端 40001（@limitation 一）
        if (expectedUpdatedAt === '') {
          sink.error('缺少商品版本信息（updated_at）：请返回列表重新进入编辑，再保存');
          return;
        }
        id = editId;
        row = await updateProduct(api, id, body, expectedUpdatedAt);
      }
      // ⚠️ 保存成功后必须同步基线：表单已提交，它不再是"未保存的改动"
      setPristine(submitted);
      // 换成服务端这一版的凭据（只在"上架失败、留在本页"时会用到；回列表时无所谓）
      setExpectedUpdatedAt(sourceUpdatedAt(row));
      setOriginalStock(productFormModel(row).stock || submitted.stock);
      const savedStatus = statusOf(row) ?? (wasNew ? 'draft' : status);
      setStatus(savedStatus);
      if (!publish) {
        onDone(wasNew ? `已保存为草稿「${title}」` : `已保存「${title}」`);
        return;
      }
      try {
        await setProductStatus(api, id, 'active');
      } catch (e) {
        // 第一步已落库：说清"存下了什么"，再说上架为什么没成（AJ-403 文件头）
        const { text: why, traceId } = toastError(e, '上架失败');
        const kept = savedStatus === 'offline' ? '已保存（仍为已下架）' : '已保存为草稿';
        sink.error(`${kept}，但上架失败：${why}。改好后再点「保存并上架」`, { traceId });
        return;
      }
      onDone(wasNew ? `已创建并上架「${title}」` : `已保存并上架「${title}」`);
    } catch (e) {
      // @see @limitation 一：失败保留表单
      const { text, traceId } = toastError(e, '保存失败');
      // 40914：表单**没被清**；下一步是"加载最新值对照"，而不是回列表（那会丢掉表单，P2-44）
      if (e instanceof ApiError && e.code === 40914) {
        setConflict(true);
        setLatest(null);
        sink.error(
          `${e.message}：你填的内容都还在。请点「加载最新值对照」看对方改了什么，核对后再保存`,
          { traceId },
        );
      } else if (e instanceof ApiError && e.code === 40001 && serverFieldError(e.data) !== null) {
        // AJ-488：服务端说清是哪一项（如售价超过单笔上限——上限在服务端配置里，前端校验不知道）
        const f = serverFieldError(e.data);
        if (f !== null) {
          setErrors({ [f.key]: f.text });
          sink.error(
            `保存失败：${f.text}${f.more > 0 ? `（还有 ${String(f.more)} 处，改好这一处再保存会提示下一处）` : ''}`,
            { traceId },
          );
        }
      } else {
        sink.error(text, { traceId });
      }
    } finally {
      setSaving(false);
    }
  };

  const loadLatest = async (): Promise<void> => {
    if (editId === null) return;
    setLoadingLatest(true);
    try {
      const fresh = await findProductById(api, editId);
      if (fresh === null) {
        sink.error('在商品列表里找不到这条商品（可能已被删除）：你填的内容还在，可复制留存');
        return;
      }
      setLatest(fresh);
      // 换成最新一版的凭据：之后保存 = 看过对方改动后，用你的内容覆盖最新一版
      setExpectedUpdatedAt(sourceUpdatedAt(fresh));
      // 库存凭据同步换成最新值：之后保存 = "看过最新库存后，用我填的数覆盖"（与上一行同一语义）
      setOriginalStock(productFormModel(fresh).stock);
      sink.error('');
    } catch (e) {
      const { text, traceId } = toastError(e, '取最新一版失败');
      sink.error(text, { traceId });
    } finally {
      setLoadingLatest(false);
    }
  };

  /** 一次选多张：按选的顺序逐张上传（不并发：顺序就是展示顺序），一张失败不挡后面的（全入口点击测试 2026-10-12）。 */
  const onUpload = async (files: File[]) => {
    setUploading(true);
    sink.error('');
    try {
      for (const file of files) await uploadOne(file);
    } finally {
      setUploading(false);
    }
  };

  const uploadOne = async (file: File) => {
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
      const { text, traceId } = toastError(e, `图片「${file.name}」上传失败`);
      sink.error(text, { traceId });
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">{editId === null ? '新建商品' : '编辑商品'}</h1>
        <button
          type="button"
          className="link"
          onClick={() => (dirty ? setLeaveAsk(true) : onDone())}
        >
          返回列表
        </button>
        {leaveAsk && (
          <ConfirmDialog
            spec={LEAVE_UNSAVED_SPEC}
            onConfirm={() => onDone()}
            onCancel={() => setLeaveAsk(false)}
          />
        )}
      </header>

      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
      {/* AJ-410 / N26：列出要改的字段名，点一下跳到那一格并把光标放进去（原先只说"有 N 项需要修正"，要自己往下找）。
          只列字段名不重复原因：原因已在那一格下面（productFormSummary 的 @why：同一句话不在一屏出现两次） */}
      {Object.keys(errors).length > 0 && (
        <div className="error-list" aria-label="需要修正的项">
          <span className="muted">点一下跳过去：</span>
          {Object.keys(errors).map((key) => (
            <button key={key} type="button" className="link" onClick={() => focusProductField(key)}>
              {productFieldLabel(key)}
            </button>
          ))}
        </div>
      )}

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
              {productConflictRows(form, latest, (k) => categoryName(categories, k)).map((r) => (
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

      {/* 回车不提交（审查 2026-10-09 #3）：单行输入框里按回车会触发浏览器隐式提交，等于"在售价框按回车 = 直接写库并离开"。
          与全站约定（ui/keys.ts：回车最多打开确认）同口径——保存只认页底两个按钮的点击。 */}
      <form className="product-grid" onSubmit={(e) => e.preventDefault()}>
        <ProductMainColumn
          form={form}
          set={set}
          errors={errors}
          tagDraft={tagDraft}
          onTagDraftChange={setTagDraft}
          uploading={uploading}
          onUpload={(files) => void onUpload(files)}
          onRemoveImage={(i) =>
            setForm((prev) => ({ ...prev, images: prev.images.filter((_, k) => k !== i) }))
          }
          onMoveImage={(from, to) =>
            setForm((prev) => ({ ...prev, images: moveImage(prev.images, from, to) }))
          }
          onMakeMain={(i) =>
            setForm((prev) => ({ ...prev, images: makeMainImage(prev.images, i) }))
          }
        />
        <ProductSideColumn
          categoryOptions={categoryOptions(categories, form.category)}
          form={form}
          set={set}
          errors={errors}
          statusCard={
            <>
              <p>
                当前：
                <strong>
                  {status !== null
                    ? STATUS_LABELS[status]
                    : editId === null
                      ? '新建（保存后为草稿）'
                      : '未知'}
                </strong>
              </p>
              <p className="muted">
                {status === 'active'
                  ? '在售商品的上下架请在列表页操作'
                  : '草稿与已下架商品买家都看不见；「保存并上架」会先保存，再检查重量是否超出运费表'}
              </p>
              {/* 只提示不拦（全入口点击测试 2026-10-12）：没图也能上架，买家卡片显示占位——运营常是先上架后补图，
                  拦了会卡住；但不提示的话，上架那一下没人意识到买家看到的是空白卡。在售商品的提示归列表的「无图」 */}
              {status !== 'active' && form.images.length === 0 && (
                <p className="warn">
                  还没有商品图：上架后买家看到的是灰色占位，建议先上传至少一张主图
                </p>
              )}
            </>
          }
        />
        {/* AJ-410 / N25：保存按钮放在页底**吸底**条里——长表单填到下面时不用再滚回顶部找按钮 */}
        <div className="sticky-actions">
          <div className="action-bar">
            {/* 有「保存并上架」时它是主动作（实心），保存降为描边；在售商品只剩「保存」，它就是主动作 */}
            <button
              type="button"
              className={status !== 'active' ? 'btn btn-secondary' : 'btn'}
              disabled={saving || uploading}
              onClick={() => void onSubmit(false)}
            >
              {saving
                ? '保存中…'
                : uploading
                  ? '图片上传中…'
                  : editId === null
                    ? '保存为草稿'
                    : '保存'}
            </button>
            {status !== 'active' && (
              <button
                type="button"
                className="btn"
                disabled={saving || uploading}
                onClick={() => void onSubmit(true)}
              >
                保存并上架
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

/**
 * 顶部错误清单点一下 → 滚到那一格并聚焦（N26）。
 * @limitation 只有带 `fieldKey` 的文本框 / 下拉有 id；标签类控件（合规 / 编辑标签）找不到时不动——清单里仍写着是哪一项。
 */
function focusProductField(key: string): void {
  const el = document.getElementById(productFieldId(key));
  if (el === null) return;
  el.scrollIntoView?.({ block: 'center' });
  el.focus();
}

/** 行里的 status → 已知状态；认不出 / 没有 → null（状态卡显示"新建"语义只在 source 为 null 时成立）。 */
function statusOf(p: AdminProductLike | null): ProductStatus | null {
  const st = p?.status;
  return st === 'active' || st === 'offline' || st === 'draft' ? st : null;
}
