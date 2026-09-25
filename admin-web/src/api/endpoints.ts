/**
 * 职责：admin-web 的接口定义层（F15 单元③）——路径、请求体形状、响应形状收口。
 * 边界：只管"调哪个接口、拿什么形状的出入参"；怎么发请求在 client.ts，UI 在组件层。
 *
 * @why 路径集中在这里而不是散在组件里：契约（api-contract.yaml）改版时只查一个文件；
 *      且"响应形状校验"有统一的落点——服务端契约变更时**在这里**硬失败，
 *      而不是让 undefined 流进 UI 变成"页面显示了空白但不报错"。
 *
 * @see contracts/api-contract.yaml（/auth/admin/login）；./client.ts
 */
import { ApiError, NETWORK_ERROR_CODE } from './errors.js';

/** createAdminApi 的返回类型（避免把 requestApi 的签名抄第二份）。 */
export type AdminApi = ReturnType<typeof import('./client.js').createAdminApi>;

/** 契约响应形状：POST /auth/admin/login → 200 {token: string}（api-contract.yaml 47-52 行）。 */
interface LoginResp {
  token: string;
}

function isLoginResp(value: unknown): value is LoginResp {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { token?: unknown }).token === 'string' &&
    (value as { token: string }).token.length > 0
  );
}

/**
 * 管理端邮箱密码登录。
 * @returns JWT（aud=admin，12 小时；契约口径）
 * @throws {ApiError} 40101 邮箱或密码错 / 40301 非管理员；
 *         响应形状与契约不符时 NETWORK_ERROR_CODE（契约被改了的信号，不是"登录失败"）
 */
export async function login(
  api: AdminApi,
  cred: { email: string; password: string },
): Promise<string> {
  // ⚠️ 显式生成 traceId 并复用（二次审查 P3）：形状校验失败抛错时要把它带出去——
  //    曾经这里写的是常量 'login-shape' 冒充报障码，服务端日志按它什么都查不到，
  //    与 N8"报障码必须能检索"的承诺相反。显式传入后，请求与报错是同一条链路。
  const traceId = crypto.randomUUID();
  const resp = await api({
    path: '/api/v1/auth/admin/login',
    method: 'POST',
    body: { email: cred.email, password: cred.password },
    traceId,
  });
  if (!isLoginResp(resp)) {
    // 契约漂移（200 但形状变了）：按"网络层异常"报，让日志/报障能区分"密码错"与"契约变了"
    throw new ApiError(NETWORK_ERROR_CODE, '登录响应形状与契约不符', traceId);
  }
  return resp.token;
}
