/**
 * 职责：给 Express 的 Request 补 `auth`（通过鉴权后的身份）。
 * @why 鉴权中间件必须把身份交给下游路由，但 Express 的类型里没有这个字段；
 *      用声明合并而不是 `as any` 强转，是为了让"没经过守卫的路由访问 req.auth"在类型层面就不成立。
 * @limitation 这是**全局**增强：任何路由都能写 req.auth。因此约定只有 `requireRole` 会写它，
 *             代码评审时把"req.auth =" 当作红线（除中间件外出现即为违规）。
 */
import type { Principal } from './auth.js';

declare global {
  namespace Express {
    interface Request {
      /** 经过 requireRole 之后才有值；未过守卫的路由读到 undefined。 */
      auth?: Principal | undefined;
    }
  }
}

export {};
