/**
 * 职责：admin-web 的运行配置解析（F15 单元②）——API 根地址从环境变量到可用值的收口。
 * 边界：只做"读环境 + 形状校验 + 默认值"；不发起请求（那是 client.ts）。
 *
 * @why 做成纯函数而不是在模块顶层直接读 `import.meta.env`：
 *      顶层读取让"环境是什么"变成不可测的隐式输入，且模块一 import 就定型；
 *      纯函数让"默认值/空串/非法值"三个分支可以各有一条用例（§2：环境变量解析必须有测试）。
 *
 * @see client.ts（normalizeBaseUrl 的消费方）；.env.example PUBLIC_API_BASE（服务端同口径变量）
 */

/** 本地开发的 API 默认地址（与 .env.example 的 PUBLIC_API_BASE 一致）。 */
export const DEFAULT_API_BASE = 'http://localhost:3000';

/**
 * 校验并归一 API 根地址：http(s) absolute，尾斜杠归一（拼 path 不双斜杠）。
 * @why 形状不符在**构造期**硬失败而不是等第一次请求：相对路径会把请求打到静态站
 *      自己身上，表现为全部 404 且 CORS 不报错，排查方向全错。
 * @why 住在 config.ts 而不是 client.ts：它是**环境配置**的形状规则，
 *      与 resolveApiBase 是同一件事的两半（拆分后 client.ts 只做"发请求"）。
 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+$/.test(trimmed)) {
    throw new TypeError(
      `baseUrl 必须是 http(s) 绝对地址，收到「${value}」——相对路径会把请求打到静态站自己身上`,
    );
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * 解析 API 根地址。
 * @param env 环境表（生产传 `import.meta.env`；`VITE_` 前缀是 Vite 唯一会注入前端的变量族）
 * @returns 可用的 absolute base URL（尾斜杠已归一、http(s) 形状已校验）
 * @throws {TypeError} 显式给了值但形状非法（拼错协议/相对路径）——
 *         空值回落默认值，**错值必须硬失败**：相对路径会把请求打到静态站自己身上，
 *         全部 404 且不报 CORS 错（见 client.ts baseUrl 的注释）
 */
export function resolveApiBase(env: Record<string, string | undefined>): string {
  const raw = env['VITE_API_BASE_URL'];
  // 空串/纯空白按"未设置"处理（§2 第 37 条：「空串 = 未设置」只在经过预处理的地方成立，
  // 这里就是那个预处理点——裸读 env 不挡空串）
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_API_BASE;
  return normalizeBaseUrl(raw);
}
