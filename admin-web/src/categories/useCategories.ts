/**
 * 职责：分类列表的共享取数（AJ-491）——商品表单 / 商品列表 / Banner / 分类管理页共用一份，进页面取一次。
 * @why 模块级缓存 + 订阅：分类管理页改完后 `refreshCategories` 一次，其它页再打开就是新的，不用各自记得刷新。
 * @limitation 缓存只在本标签页内；别的管理员在另一台电脑改了分类，这边要刷新页面才看到（分类改动很少，可以接受）。
 */
import { useEffect, useState } from 'react';
import { listCategories, type AdminApi, type AdminCategory } from './api.js';

let cache: AdminCategory[] | null = null;
let inflight: Promise<AdminCategory[]> | null = null;
const listeners = new Set<(l: AdminCategory[]) => void>();

export async function refreshCategories(api: AdminApi): Promise<AdminCategory[]> {
  inflight ??= listCategories(api).finally(() => {
    inflight = null;
  });
  const list = await inflight;
  cache = list;
  for (const fn of listeners) fn(list);
  return list;
}

/** 测试用：清掉模块缓存（各用例之间互不影响）。 */
export function resetCategoryCache(): void {
  cache = null;
  inflight = null;
}

/** 测试用：预置分类列表（别的页面的用例不必为"取分类"这一请求改各自的假接口与调用计数）。 */
export function primeCategoryCache(list: AdminCategory[]): void {
  cache = list;
  inflight = null;
}

/**
 * @param opts.fresh 进页面时不论有没有缓存都重新取一次——分类管理页用（真实界面实测 2026-10-11：先在商品编辑页
 *        把商品改到新分类，再回分类页，看到的还是旧的在售数）。下拉框类的页面不必（名称很少变）。
 */
export function useCategories(
  api: AdminApi,
  opts: { fresh?: boolean } = {},
): { list: AdminCategory[]; error: boolean } {
  const fresh = opts.fresh === true;
  const [list, setList] = useState<AdminCategory[]>(fresh ? [] : (cache ?? []));
  const [error, setError] = useState(false);
  useEffect(() => {
    listeners.add(setList);
    if (cache === null || fresh) {
      refreshCategories(api).catch(() => {
        setError(true);
      });
    }
    return () => {
      listeners.delete(setList);
    };
  }, [api, fresh]);
  return { list, error };
}
