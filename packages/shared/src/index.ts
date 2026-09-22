/**
 * 职责：前后端共享契约包（错误码注册表、订单状态/货币/渠道枚举、API 类型）。
 * 边界：只放类型与常量，不放任何运行时业务逻辑；server / admin-web / miniprogram 三端同源引用。
 * 依赖方向：被各端引用，自身零依赖。
 * @see api-contract.yaml 0.5.0（类型由它生成）、docs/地基搭建清单.md F2、技术文档 v0.5 §7（错误码）
 * @limitation F0 阶段为占位；F2 接入 openapi-typescript 自动生成后，手改本目录视为违规（gate 报红）。
 */
export {};
