/**
 * 职责：前后端共享契约包（错误码注册表、枚举、由 api-contract.yaml 生成的 API 类型）。
 * 边界：只放类型与常量，不放任何运行时业务逻辑；server / admin-web / miniprogram 三端同源引用。
 * 依赖方向：被各端引用，自身零依赖。
 * @see contracts/api-contract.yaml（版本以其 info.version 为准）；docs/地基搭建清单.md F2、技术文档 v0.5 §7（错误码）
 * @limitation API 类型自动生成（openapi-typescript）尚未接入：
 *             在此之前三端共用本包的常量部分，接口结构仍以 yaml 为准，由 scripts/check-contract.mjs 防漂移。
 * @why 给三端一个稳定的导入入口：各端若直接引用内部文件路径，内部重构时会被静默打破。
 *      barrel 的代价是 tree-shaking 变差，MVP 规模下可以忽略。
 */
export * from './errors.js';
export * from './enums.js';
export * from './id.js';
export * from './limits.js';
export * from './money.js';
export * from './orderNo.js';
export * from './businessDay.js';
export * from './design-tokens.js';
