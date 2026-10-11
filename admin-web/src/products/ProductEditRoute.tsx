/**
 * 职责：商品编辑页的**网址入口**（代理 G8，第二轮审计 2026-10-11）——`#/products/<id>` 编辑、`#/products/new` 新建。
 *
 * @why 原先编辑态只在内存里（App 的 `editing`），地址栏停在 `#/products`：刷新、新开标签、把链接发给同事，
 *      都会回到列表；连续改几件商品要反复进出。商品多、每天都在改的店，这是实打实的效率损失。
 * @why 原来不进网址的理由是"契约没有按 id 取单件商品的接口，刷新后表单会是空的"。现在用 `findProductById`
 *      （翻商品列表按 id 找，"加载最新值对照"已在用）兑现深链接：从列表点进来的直接用列表那一版（不多发请求），
 *      刷新 / 链接打开的先取数、取到再挂表单——表单在挂载时用原始数据初始化，不能先挂一张空表单再填。
 * @limitation 一：`findProductById` 最多翻 20 页 × 100 件，超过 2000 件商品时排在后面的会显示"没找到"。
 *              本项目商品规模远小于此；真到那一天应补 `GET /admin/products/{id}`。
 * @limitation 二：找不到（已删除 / 链接里的 id 打错）时明说并给「返回列表」，不显示一张空表单——
 *              空表单会被当成"商品数据丢了"，保存还会建出一件新商品。
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { findProductById, type AdminApi, type AdminProductLike } from './api.js';
import { ProductFormPage, type ProductFormPageProps } from './ProductFormPage.js';

/** 网址里"新建商品"的占位 id（真实商品 id 不会是这个词）。 */
export const NEW_PRODUCT_ROUTE_ID = 'new';

export interface ProductEditRouteProps extends Omit<ProductFormPageProps, 'productId' | 'source'> {
  api: AdminApi;
  /** 网址里的 id（`NEW_PRODUCT_ROUTE_ID` = 新建）。 */
  routeId: string;
  /** 从列表点进来时带的那一版（id 对得上才用，否则重新取）。 */
  cached: AdminProductLike | null;
}

type LoadState =
  | { kind: 'ready'; source: AdminProductLike | null }
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; text: string };

function initial(routeId: string, cached: AdminProductLike | null): LoadState {
  if (routeId === NEW_PRODUCT_ROUTE_ID) return { kind: 'ready', source: null };
  if (cached !== null && cached.id === routeId) return { kind: 'ready', source: cached };
  return { kind: 'loading' };
}

export function ProductEditRoute({ routeId, cached, ...form }: ProductEditRouteProps) {
  const [state, setState] = useState<LoadState>(() => initial(routeId, cached));

  useEffect(() => {
    if (state.kind !== 'loading') return;
    let live = true;
    findProductById(form.api, routeId)
      .then((p) => {
        if (live) setState(p === null ? { kind: 'missing' } : { kind: 'ready', source: p });
      })
      .catch((e: unknown) => {
        if (live) setState({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [state.kind, routeId, form.api]);

  if (state.kind === 'ready') {
    return (
      <ProductFormPage
        {...form}
        productId={routeId === NEW_PRODUCT_ROUTE_ID ? null : routeId}
        source={state.source}
      />
    );
  }
  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">商品</h1>
        <button type="button" className="link" onClick={() => form.onDone()}>
          返回列表
        </button>
      </header>
      {state.kind === 'loading' && <p className="muted">加载中…</p>}
      {state.kind === 'missing' && (
        <p className="warn">
          没找到这件商品（可能已被删除，或链接里的编号不对）。请回到列表重新查找。
        </p>
      )}
      {state.kind === 'error' && (
        <div className="warn">
          <p>商品信息没取到：{state.text}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setState({ kind: 'loading' })}
          >
            重试
          </button>
        </div>
      )}
    </section>
  );
}
