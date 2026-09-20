# jp_project — 日本直邮小程序代码库

设计文档在知识库仓库 `WaSelectDoc/50-产品与技术/`，代码以以下三份为契约：

- `技术架构/技术文档.md`（v0.4）：编码约定、状态机、11 表 DDL、PaymentProvider v2.1、登录与 H5 衔接、域名 / 隐私 / 审核细则
- `技术架构/api-contract.yaml`（0.4.0）：OpenAPI 3.0，前后端共同依据
- `需求与设计/需求文档PRD-v1.6.md` §3：P0 范围

目录（见《工程框架文档 v0.4》）：`miniprogram/`（原生小程序 TS，9 页 + web-view 容器页）、`server/`（Node.ts + postgres.js，八模块）、`checkout-h5/`（Stripe Payment Element 收银页）、`admin-web/`（独立管理后台）。

开始：`cp .env.example .env`，填 `DATABASE_URL`、`JWT_SECRET`，`PAYMENT_CHANNELS=mock,stripe`。

开发前审计记录：`docs/开发前审计报告-2026-09-19.md`（三轮，§8 为小程序专项）。
