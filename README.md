# jp_project — 日本直邮小程序代码库

设计文档在知识库仓库 `WaSelectDoc/50-产品与技术/`，代码以以下三份为契约：

- `技术架构/技术文档.md`（v0.5）：编码约定、状态机、13 表 DDL、PaymentProvider v2.1（Stripe Checkout 托管页）、复制链接支付入口、拒付、域名 / 隐私 / 审核细则
- `技术架构/api-contract.yaml`（0.5.0）：OpenAPI 3.0，前后端共同依据
- `需求与设计/需求文档PRD-v1.6.md` §3：P0 范围

目录（见《工程框架文档 v0.5》）：`miniprogram/`（原生小程序 TS，9 页 + 银行卡支付引导页）、`server/`（Node.ts + postgres.js，九模块）、`checkout-static/`（Cloudflare Pages 静态站：`_redirects` → Stripe Checkout 托管页 + 结果页）、`admin-web/`（独立管理后台，前置 Cloudflare Access）。

开始：`cp .env.example .env`，填 `DATABASE_URL`、`JWT_SECRET`，`PAYMENT_CHANNELS=mock,stripe`。

**可扩展性**：先读 `docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md`（ADR-28）——业务核心不认识任何具体支付方式/国家/UI：支付走 Provider 注册表 + 能力声明 + 配置表；多国家走 `country_profiles` + `shipping_rates.dest_country` + `duty_rates`；UI 走 design token + 页面/表单 schema，禁止写死色值、金额、国家、承运商、模块顺序。

**注释与日志**：先读 `docs/代码注释规范与日志体系设计.md`（ADR-29）——注释必须写清逻辑、**缺点**与优点（`@limitation` / `@tradeoff` / `@see ADR-xx`）；日志三条流（运行 / 业务审计 / 用户行为）统一 `trace_id` 串联，脱敏红线见该文 §8，关键路径测试必须断言日志与事件落库。

**地基搭建清单**：写第一行业务代码前，按 `docs/地基搭建清单.md` 的 17 项、6 个阶段搭好测试、配置、错误、日志、数据库、幂等、假数据、分层事件、可插拔注册表、调度器、外部调用、共享契约、前端地基与 CI。

**测试门禁**：先读 `docs/测试策略与验证门禁.md` —— 四条铁律（T-1 无绿灯不写下一步 / T-2 先红后绿 / T-3 依赖要真只有三方要假 / T-4 假数据完整模拟真实）、最小单元粒度、必测清单（含运费取档 `w=1850 → 4950`）。每个单元交付前跑 `npm run gate`，全绿才算完成。

开发前审计记录：`docs/开发前审计报告-2026-09-19.md`（十六轮，§8 为小程序专项，§21 为第十六轮从头评审）。
