/**
 * 职责：**未保存提醒**（第一批⑥）——表单脏态上报 + 关标签页的原生拦截 + 站内导航的二次确认。
 *
 * @why 单独一个模块：脏态是**跨组件**的状态——表单在 `products/` 与 `banners/` 里，
 *      而"要拦截离开"的决策点在 `App.tsx` 的侧栏按钮上。没有这一层，
 *      要么每个页面自己 addEventListener（换一个入口 / 加一个表单页就漏一处），
 *      要么 App 去猜"当前页是不是表单"（猜必错）。
 *
 * @why context 而不是 module-level 单例：单例在同时挂载两个表单时会互相覆盖，
 *      而 DOM 用例里多个（implanted）组件并存是常态；context 的默认值还让"没有 Provider"这一场景
 *      退化成不提醒，而不是抛错。
 *
 * @limitation 一：**不做本地草稿**。提醒只回答"你是不是要丢掉它"，
 *      草稿要引入"草稿 vs 已保存"两套状态与合并规则（ProductFormPage @limitation 二同一决定）。
 * @limitation 二：脏态只比**表单模型**与标签草稿（此刻屏幕上能看见的输入），
 *      不含"已上传但还没保存的图片"这类副作用——它们由各页面自己的 `uploading` 管。
 *
 * @see ../../docs/管理后台对标分析-成熟电商平台-2026-10-08.md §8-1⑥；./confirm.tsx（二次确认弹层）
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';

/** 两份表单模型是否一致；认不出（循环引用等）按**不一致**处理——宁可多提醒一次。 */
export function sameForm(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export interface UnsavedContext {
  /** 当前是否有未保存的改动。 */
  dirty: boolean;
  /**
   * 由**表单**调用：`key` 这一份表单变脏 / 恢复干净。
   * @why 按 key 记而不是一个布尔：订单详情一页同时挂着发货、退款、改址、备注好几份表单，
   *      单布尔下"B 恢复干净 / B 卸载"会把"A 还脏着"一并抹掉——提醒在最该弹的时候不弹。
   */
  markDirty: (key: string, dirty: boolean) => void;
}

/**
 * 默认值：没有 Provider 时不提醒。
 * @why 组件被单独挂载（DOM 用例、将来在别处复用）时不该崩，也不该假装有守卫——
 *      提醒失效是"可能丢数据"，报错却会让整页白屏。
 */
export const UnsavedCtx = createContext<UnsavedContext>({
  dirty: false,
  markDirty: () => undefined,
});

/**
 * 脏态登记簿（App 与 DOM 用例共用）：哪几份表单脏着，任意一份脏 = 整页脏。
 * @returns `clear` 供"确认放弃并离开"一次性清空（表单随后卸载，各自的清理是幂等的）。
 */
export function useDirtyRegistry(): {
  dirty: boolean;
  markDirty: (key: string, dirty: boolean) => void;
  clear: () => void;
} {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const markDirty = useCallback((key: string, dirty: boolean) => {
    setKeys((prev) => {
      if (prev.has(key) === dirty) return prev; // 不变就返回原对象：避免无谓重渲染
      const next = new Set(prev);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const clear = useCallback(() => setKeys(new Set()), []);
  return { dirty: keys.size > 0, markDirty, clear };
}

export function useUnsaved(): UnsavedContext {
  return useContext(UnsavedCtx);
}

export interface UnsavedProviderProps {
  dirty: boolean;
  markDirty: (key: string, dirty: boolean) => void;
  /**
   * ⚠️ 必须是**可选**：`createElement(UnsavedProvider, props, ...children)` 这一种调用
   *    在 children 必填时落不到正确的重载上（TS2769），而 App.tsx 里的 `<UnsavedProvider …/>` 写法不受影响。
   */
  children?: ReactNode;
}

/** 把 App 持有的脏态下发（Provider 必须挂在比侧栏更外层的地方）。 */
export function UnsavedProvider({ dirty, markDirty, children }: UnsavedProviderProps): JSX.Element {
  return <UnsavedCtx.Provider value={{ dirty, markDirty }}>{children}</UnsavedCtx.Provider>;
}

/**
 * 关标签页 / 刷新 / 前进后退出站的原生提醒。
 *
 * @why `preventDefault()` 与 `returnValue` **两个都要**：现代浏览器看前者，
 *      旧 Safari / 部分旧 Edge 只读后者；只写一个在另一半浏览器里等于没提醒。
 * @limitation 浏览器**不允许**自定义这句话的文案（防钓鱼），只能换到`null` 关掉——
 *              所以"未保存会丢"这四个字要写在我们自己的二次确认弹层里（App.tsx）。
 */
export function useBeforeUnload(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [dirty]);
}

/**
 * 表单页用：把"当前值 vs 未改动基线"的差异常态化上报给 App。
 *
 * @why 卸载时 `markDirty(false)`：不还原的话，从上一个表单切走之后
 *      App 里的脏态一直是 true —— 接下来点任何侧栏都会弹出"要离开吗"，
 *     这就是把"保护"变成了"骚扰"。
 * @limitation 比较用 JSON 序列化：`Date` / `Map` 之类的值比不出差异（会漏判），
 *             本仓的表单模型都是平铺的 string / string[]，没有这类值。
 */
export function useFormDirty<T>(current: T, pristine: T): void {
  const { markDirty } = useUnsaved();
  const key = useId();
  const dirty = !sameForm(current, pristine);
  useEffect(() => {
    markDirty(key, dirty);
    return () => markDirty(key, false);
  }, [key, dirty, markDirty]);
}

/**
 * 组件版 useFormDirty：放进 `<ActionDrawer>` 的 children 里用。
 *
 * @why 自己渲染抽屉的组件（批量发货 / CSV 导入）若在**自身**调 useFormDirty，拿到的是抽屉**外层**的登记簿——
 *      抽屉的"关闭前问一句"只看自己 Provider 里的 local 脏态，于是填了内容关抽屉不问（验收 2026-10-08 实测）。
 *      挂在 children 里才落进抽屉的 Provider（抽屉再转报外层，侧栏离开同样会拦）。
 */
export function FormDirty<T>({ current, pristine }: { current: T; pristine: T }): null {
  useFormDirty(current, pristine);
  return null;
}
