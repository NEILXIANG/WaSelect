# jp_project — 日本直邮小程序代码库

设计文档在知识库仓库 `WaSelectDoc/50-产品与技术/`，代码以以下三份为契约：

- `技术架构/技术文档.md`（v0.3）：编码约定、状态机、DDL、PaymentProvider v2、登录
- `技术架构/api-contract.yaml`：OpenAPI 3.0，前后端共同依据
- `需求与设计/需求文档PRD-v1.5.md` §3：P0 范围

目录（见《工程框架文档》）：`miniprogram/`（原生小程序 TS）、`server/`（Node.ts + postgres.js）、`checkout-h5/`（Stripe 收银页）。

开始：`cp .env.example .env`，填 `DATABASE_URL`，`PAYMENT_CHANNELS=mock,stripe`。
