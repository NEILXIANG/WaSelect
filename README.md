# jp_project — 日本直邮小程序代码库

设计文档在知识库仓库 `WaSelectDoc/50-产品与技术/`，代码以以下三份为契约：

- `技术架构/技术文档.md`（v0.5）：编码约定、状态机、13 表 DDL、PaymentProvider v2.1（Stripe Checkout 托管页）、复制链接支付入口、拒付、域名 / 隐私 / 审核细则
- `技术架构/api-contract.yaml`（0.5.0）：OpenAPI 3.0，前后端共同依据
- `需求与设计/需求文档PRD-v1.6.md` §3：P0 范围

目录（见《工程框架文档 v0.5》）：`miniprogram/`（原生小程序 TS，9 页 + 银行卡支付引导页）、`server/`（Node.ts + postgres.js，九模块）、`checkout-static/`（Cloudflare Pages 静态站：`_redirects` → Stripe Checkout 托管页 + 结果页）、`admin-web/`（独立管理后台，前置 Cloudflare Access）。

开始：`cp .env.example .env`，填 `DATABASE_URL`、`JWT_SECRET`，`PAYMENT_CHANNELS=mock,stripe`。

开发前审计记录：`docs/开发前审计报告-2026-09-19.md`（十六轮，§8 为小程序专项，§21 为第十六轮从头评审）。
