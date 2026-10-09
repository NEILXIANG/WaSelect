/**
 * 职责：管理端前端报错上报器（AJ-421）——把错误边界 / 全局 error / 未处理拒绝收成一条
 *       `POST /api/v1/admin/client-errors`，并在客户端做去重、限量、截断。
 *
 * @why 去重键 = **只看 message**（不含 kind）：同一个渲染错误在 StrictMode 下会触发两次、列表每一行都会抛一次；
 *      而且 React 开发模式会把错误边界**已经接住**的渲染异常再派发一次到 window 的 error 事件
 *      （@measured React 18.3.1 + jsdom，2026-10-09：边界接住一次渲染异常时
 *       `{"winErrors":2,"reports":1}`——window error 触发 2 次、边界上报 1 次；生产构建不重放，未实测），
 *      按 kind + message 去重会让同一个错误以 render 与 error 各报一次。
 * @why 每次页面加载最多 10 条（`maxPerLoad`）：服务端不限频（admin-client-error-routes.ts @limitation 一），
 *      限量放在源头；刷新页面即重置——运营刷新后再出错，说明问题还在，值得再报。
 * @why 截断在这里做（消息 500、调用栈 2000）：服务端超长是拒绝而不是截断（client-error-input.ts @why），
 *      前端知道哪一段最有用（调用栈的开头）。
 * @why 发送失败**一律吞掉**：上报是"顺便"，它失败不能变成新的报错（否则全局 error 监听会把自己的失败再报一遍，
 *      形成环）；也不能弹登录框——调用方传入的 `send` 用的是不接 `onUnauthorized` 的请求实例。
 * @limitation 一：页面在上报发出前就被关掉，那条会丢（不用 sendBeacon：它带不了 Authorization 头）。
 * @limitation 二：去重只在本次加载内，跨标签页 / 刷新后不去重。
 * @see server/src/app/admin-client-error-routes.ts；./ErrorBoundary.tsx
 */

export type ClientErrorKind = 'render' | 'error' | 'rejection';

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string | undefined;
  /** 当前页名（路由 page，如 `orders`）。 */
  page?: string | undefined;
}

/** 与服务端 client-error-input.ts 同值（超出服务端会拒绝，这里先截）。 */
export const REPORT_MESSAGE_MAX = 500;
export const REPORT_STACK_MAX = 2000;

const PAGE_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface ErrorReporter {
  report(r: ClientErrorReport): void;
}

/** 任意抛出物 → 消息与调用栈（非 Error 的抛出物也要能报：`throw '字符串'`、拒绝原因是对象）。 */
export function describeThrown(thrown: unknown): { message: string; stack: string | undefined } {
  if (thrown instanceof Error) {
    return { message: thrown.message || thrown.name, stack: thrown.stack };
  }
  if (typeof thrown === 'string') return { message: thrown, stack: undefined };
  try {
    return { message: JSON.stringify(thrown) ?? String(thrown), stack: undefined };
  } catch {
    return { message: String(thrown), stack: undefined };
  }
}

export function createErrorReporter(deps: {
  send: (body: Record<string, string>) => Promise<unknown>;
  maxPerLoad?: number;
}): ErrorReporter {
  const max = deps.maxPerLoad ?? 10;
  const seen = new Set<string>();
  let sent = 0;
  return {
    report(r) {
      const message = r.message.trim().slice(0, REPORT_MESSAGE_MAX);
      if (message === '') return;
      if (seen.has(message) || sent >= max) return;
      seen.add(message);
      sent += 1;
      const body: Record<string, string> = { kind: r.kind, message };
      if (typeof r.stack === 'string' && r.stack !== '')
        body['stack'] = r.stack.slice(0, REPORT_STACK_MAX);
      if (typeof r.page === 'string' && PAGE_RE.test(r.page)) body['page'] = r.page;
      deps.send(body).catch(() => undefined);
    },
  };
}
