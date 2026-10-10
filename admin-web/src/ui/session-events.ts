/**
 * 职责：会话事件——"浮层里重新登录成功了"（第 24 项，2026-10-10）。
 *
 * @why 会话过期时，页面那次请求除了触发 AuthGate 的重新登录浮层，还会经各页的 toastError 弹一条
 *      "未登录或登录已过期"；重新登录后浮层消失，那条提示却还挂在右下角——已经登录了还说"未登录"。
 *      提示区（useToasts）分散在 40 多个调用点，逐个改不现实；由 AuthGate 发一次事件，提示区统一清掉那一句。
 * @why 用 window 上的自定义事件而不是 React context：useToasts 在各页面里各建一份，不都在同一棵 provider 下；
 *      事件不要求组件层级关系。
 * @limitation 只在浏览器（有 window）里生效；无 window 时发送与订阅都是空操作。
 * @see ../AuthGate.tsx（发送方）；./toast.tsx `useToasts`（订阅方）
 */
const RELOGIN_EVENT = 'waselect:relogin';

/** 浮层里重新登录成功后调用一次。 */
export function notifyRelogin(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(RELOGIN_EVENT));
}

/** 订阅"已重新登录"；返回取消订阅函数（给 useEffect 的清理用）。 */
export function onRelogin(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(RELOGIN_EVENT, cb);
  return () => window.removeEventListener(RELOGIN_EVENT, cb);
}
