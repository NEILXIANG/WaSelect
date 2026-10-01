# jp_project — 日本直邮小程序代码库

设计文档在知识库仓库 `WaSelectDoc/50-产品与技术/`（两仓布局：本地治理/业务文档库目录名 `jp` ↔ git 仓库 `WaSelectDoc`；本工程库目录名 `jp_project` ↔ git 仓库 `WaSelect`；两边互指链接、不重复数字），代码以以下三份为契约：

- `技术架构/技术文档.md`（v0.5.1，2026-09-28 一致性审计校正；**§0a 列出写成现行但尚未实现的项**）：编码约定、状态机、表结构 DDL、复制链接支付入口（Stripe Checkout 托管页）、拒付、域名 / 隐私 / 审核细则。支付端口定义以本库 `server/src/ports/payment.ts` 为准（技术文档 §4 的 v2.1 草图已被取代）
- `技术架构/api-contract.yaml`（版本以 `info.version` 为准，当前 0.6.17；**真源在文档库**，本库副本 `contracts/api-contract.yaml`，两份逐字一致由 `npm run check:contract` 比对；改契约先改文档库那一份再同步下来）：OpenAPI 3.0，前后端共同依据
- `需求与设计/需求文档PRD-v1.6.md` §3：P0 范围

目录：`miniprogram/`（原生小程序：WXML/WXSS/JS 为主，`utils/storage.ts`、`utils/wx-api.ts` 等少数 TS 由微信开发者工具的 TypeScript 编译插件转译；**页面逻辑一律在 `pages/*/index.vm.js`**（CLAUDE.md 约束十一）；`app.json` 注册 13 页 = 11 个业务页 + `pages/comp` 组件样板页 + 已停用的 `pages/index`（提审前应移除后两者的登记）；基础组件 ws-button / ws-price）、`server/`（Node 22 + TypeScript + Express 5 + postgres.js；分层 `domain / ports / adapters / app`，见 ADR-28——《工程框架文档》里的「九模块 / `modules/`」是旧设计口径）、`migrations/`（纯 SQL，001–016）、`checkout-static/`（Cloudflare Pages 静态站：`_redirects` 把 `/o/*` 转到 API 短链 → Stripe Checkout 托管页；结果页 `/pay/done`、`/pay/cancelled`、`/pay/expired`）、`admin-web/`（独立管理后台，React 18 + Vite，前置 Cloudflare Access）。表数口径：当前 21 张（migrations 001–016），唯一真源是 `server/src/adapters/db.db.test.ts` 的表清单断言；文档里出现的「13 表 / 17 张」是成文时的旧基准。

**前置条件**（新机器 / 新同事）：Node **22.x**（`nvm use` 读 `.nvmrc`；CI 同主版本；**主版本不对时 `npm run gate` 与提交钩子的第一步就会失败**，见 `scripts/assert-node-version.mjs`）、npm ≥ 10、本机 PostgreSQL **16**（如 `brew install postgresql@16`，代码有主版本硬闸门）、Git。要跑小程序再加：**微信开发者工具**（导入 `miniprogram/` 目录；`project.config.json` 已开启 TypeScript 编译插件，工具内「详情 → 本地设置」保持默认即可；真机点亮验证属 F16 L4 欠账）。然后：

```bash
npm install        # 装全部 workspace 依赖（prepare 钩子自动指 hooksPath）
npm run dev        # 首次自动物化 .env、建库、迁移、灌 demo 数据并起服务于 :3000
```

`.env` 生成后按需填 Stripe 等占位；`npm run dev -- --no-serve` 只准备环境，`--full` 灌完整目录。本地联调（Stripe 回调 / 公网隧道）见 `docs/dev/stripe-listen-cloudflared.md`。完成判定只有一个信号：`npm run gate` 全绿。

管理后台：`npm run dev -w admin-web`（Vite，**`:5174`**；商品 / 订单 / 运营配置 / Banner / 风控五个页签已落地，登录页走真实接口；跨域白名单见 `.env` 的 `CORS_ORIGINS`，已含本地 5174）。构建产物在 `admin-web/dist`（部署 = 静态站 + API 指 `VITE_API_BASE_URL`）。登录调 `POST /api/v1/auth/admin/login`（已实现：邮箱 + 口令，连错 5 次锁 15 分钟；初始管理员由启动时按 `ADMIN_INITIAL_EMAIL` / `ADMIN_INITIAL_PASSWORD` 建号，改密用 `npm run admin:password`，改密同时解除登录锁定）。此处曾写"该端点尚未实现、生产无法登录"——自 AJ-181 起已不成立（2026-09-30 更正）。

**可扩展性**：先读 `docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md`（ADR-28）——业务核心不认识任何具体支付方式/国家/UI：支付走 Provider 注册表 + 能力声明 + 配置表；多国家走 `country_profiles` + `shipping_rates.dest_country` + `duty_rates`（⚠️ 现状：`payment_channels` 表已建但**未接线**，启用通道仍由 env `PAYMENT_CHANNELS` + 代码内置表决定；`shipping_rates.dest_country` **尚未建列**——两者都是已登记债务，见该文）；UI 走 design token + 页面/表单 schema，禁止写死色值、金额、国家、承运商、模块顺序。

**注释与日志**：先读 `docs/代码注释规范与日志体系设计.md`（ADR-29）——注释必须写清逻辑、**缺点**与优点（`@limitation` / `@tradeoff` / `@see ADR-xx`）；日志三条流（运行 / 业务审计 / 用户行为）统一 `trace_id` 串联，脱敏红线见该文 §8，关键路径测试必须断言日志与事件落库。

**地基搭建清单**：写第一行业务代码前，按 `docs/地基搭建清单.md` 的 21 项（F0–F17 + F2b/F6b/F6c 三个增补项）、6 个阶段搭好测试、配置、错误、日志、数据库、幂等、假数据、分层事件、可插拔注册表、调度器、外部调用、共享契约、前端地基与 CI。

**测试门禁**：先读 `docs/测试策略与验证门禁.md` —— 四条铁律（T-1 无绿灯不写下一步 / T-2 先红后绿 / T-3 依赖要真只有三方要假 / T-4 假数据完整模拟真实）、最小单元粒度、必测清单（含运费取档 `w=1850 → 4950`）。每个单元交付前跑 `npm run gate`，全绿才算完成。

**新人上手顺序（onboarding）**：① 本 README → ② `CLAUDE.md`（开发纪律十一条约束，写任何代码前必读）→ ③ `docs/自主决策记录.md`（AJ 系列，AI 自主拍板的历史与依据）→ ④ 上面链接的架构 / 注释日志 / 地基清单 / 测试门禁四份细则。

开发前审计记录：`docs/开发前审计报告-2026-09-19.md`（十六轮，§8 为小程序专项，§21 为第十六轮从头评审）——⚠️ **历史档案**：第 15/16 条 H5 收银口径已被 D-49 推翻，其中的版本号、表数、路径均已过时，勿当现行依据（分层见 `docs/README.md`）。最近一次代码↔文档一致性审计：`docs/代码与文档一致性审计与修复报告-2026-09-28.md`。
