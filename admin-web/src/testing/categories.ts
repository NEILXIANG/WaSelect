/**
 * 测试夹具：后台分类列表（AJ-491）。预置四个原分类（与迁移 039 同名同序），外加一个停用分类。
 */
import type { AdminCategory } from '../categories/api.js';

export const TEST_CATEGORIES: AdminCategory[] = [
  {
    key: 'beauty',
    name: '美妆护肤',
    sort: 10,
    active: true,
    active_product_count: 5,
    product_count: 6,
  },
  {
    key: 'daily',
    name: '生活百货',
    sort: 20,
    active: true,
    active_product_count: 3,
    product_count: 3,
  },
  {
    key: 'kitchen',
    name: '厨房餐具',
    sort: 30,
    active: true,
    active_product_count: 2,
    product_count: 2,
  },
  { key: 'food', name: '食品', sort: 40, active: true, active_product_count: 9, product_count: 9 },
  { key: 'toy', name: '玩具', sort: 50, active: false, active_product_count: 0, product_count: 1 },
];
