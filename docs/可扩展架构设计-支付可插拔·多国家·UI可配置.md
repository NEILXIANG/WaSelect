# 可扩展架构设计：支付可插拔 · 多国家 · UI 可配置

> 状态：已定（设计层）｜ 版本：v1.0（2026-09-22）｜ 适用范围：`jp_project`；2026-09-28 一致性审计校正（AJ-176）
> 来源：用户 2026-09-22 明确要求——**架构要灵活，能随时增加/删除/切换支付方式、对接不同国家；业务与功能解耦；UI 不能写死，能灵活调整优化**。
> 上游契约：《技术文档 v0.5》《api-contract.yaml》（版本以 `contracts/api-contract.yaml` 的 `info.version` 为准，当前 0.6.10；AJ-176 更正原写死的 ~~0.5.3~~）《工程框架 v0.5》《测试策略与验证门禁》
> ⚠️ 本文是**工程侧单一事实来源**；治理库（jp）只在 ADR-28 存索引与结论，不复制内容。
> ⚠️ 本文提出的是**扩展点设计**，涉及 DDL / 契约的改动（见 §5）须经用户确认后，再改《技术文档》v0.6 与 `api-contract` 0.6.0；未确认前不动主契约。（AJ-176：契约此后已演进到 0.6.x，版本以真源为准）
> ⚠️ **读法（AJ-176）**：本文多数小节写的是**目标形态**；与现状不一致处已就地标注 `⚠️ 现状` / `（计划）`，现状以代码为准。

---

## 0. 一句话结论

> **业务核心（订单 / 商品 / 金额 / 状态机）不认识任何具体支付方式、任何具体国家、任何具体 UI 形态**——它们只认识"接口"和"配置"。加一种支付 = 加一个适配器 + 一行配置（⚠️ 现状：还要同时改 `packages/shared` 的 `PAYMENT_CHANNEL` 枚举与契约 `x-payment-channels` 登记表——`config.ts` 用该枚举校验 `PAYMENT_CHANNELS`，`scripts/check-contract.mjs` 做双向比对，AJ-176）；加一个国家 = 加一份国家档案 + 一批运费/税率数据；改 UI = 改 token 与后台下发的布局 schema，不改业务代码、不需要重新发版。

---

## 1. 总原则（六条）

| # | 原则 | 反例（禁止） |
|---|---|---|
| **E-1** | **端口与适配器**：领域层只依赖接口（PaymentProvider / ShippingQuoter / Notifier / Storage / FxSource），实现放 `adapters/` | 订单服务里直接 `import Stripe` 或写 `if (channel === 'stripe')` |
| **E-2** | **配置驱动，而非代码分支**：通道是否启用、优先级、适用国家/币种、UI 变体、开关，全部来自配置（DB 表），改配置不改代码、不重新发版（⚠️ 现状**仍是右列反例形态**：启用由 env `PAYMENT_CHANNELS` 决定，优先级 / 国家 / 币种 / 展示名来自 `adapters/payment/channels.ts` 的内置表 `CHANNEL_DEFAULTS`；`payment_channels` 表只有种子、消费方未接线——已登记债务 R2-4，上线前迁表，AJ-176） | `PAYMENT_CHANNELS` 只从 env 读、写死在代码常量里 |
| **E-3** | **能力声明（capabilities）**：每个适配器自报能力（支持币种 / 国家 / 退款 / 拒付 / 部分退 / 入口形态 / 上下限），由框架按能力筛选可用项，不在业务里判断"这个能不能用" | 前端写死"微信支付按钮 + 银行卡按钮"两个入口 |
| **E-4** | **领域事件解耦副作用**：通知、履约、对账、风控通过订阅领域事件实现（`order_events` 已是天然事件日志） | 支付回调里直接发邮件、直接调物流 |
| **E-5** | **规则外置**：上架校验、通道路由、定价/关税、地址校验都是"规则对象 + 注册表"，新增规则不改主体 | 上架校验 9 条写成一个大 `if` 块 |
| **E-6** | **UI 数据驱动**：颜色/间距走 design token，页面区块与表单由后端下发 schema 渲染 | WXML 里写死色值、金额、币种、国家名、承运商名、模块顺序 |

---

## 2. 支付可插拔

### 2.1 现状
`PaymentProvider` v2.1 接口已有（create / cancel / verify / refund / reconcile），三个实现（Mock / Stripe / WechatInstitution），启用靠 `PAYMENT_CHANNELS`。**不足**：通道是代码里的 `Channel` 联合类型；回调路由 `/pay/callback/stripe`、`/pay/callback/wechat` 硬编码；前端入口写死；通道上下线要改代码 + 发版。

> ⚠️ 上段是 **2026-09-22 成文时**的现状。**2026-09-28 现状**（AJ-176，以代码为准）：
> - 端口 `server/src/ports/payment.ts`：`PaymentProvider` = `create` / `parseWebhook` / 可选 `refund` / 可选 `expireSession` + `capabilities`，**没有** cancel / verify / reconcile；`channel` 是 string（不再是联合类型）。
> - 实现只有 `mock`（`adapters/payment/mock.ts`）与 `stripe`（`adapters/payment/stripe-checkout.ts`，Checkout 托管页）；**没有微信机构适配器**（R1 通过后再做；配置里写了 `wechat` 也会因未注册而静默跳过）。
> - 回调已统一为 `/api/v1/pay/callback/:channel`（`app/pay-routes.ts` 的 `PAY_CALLBACK_PREFIX`），由注册表分发。
> - 前端入口已按 `GET /pay/channels` 下发渲染（`miniprogram/pages/pay/index.js`），不再写死按钮。
> - 通道上下线：改 env `PAYMENT_CHANNELS` 后重启即可（不改代码），但仍**不是** DB 表驱动（见 E-2 现状 / R2-4）。

### 2.2 目标形态

```ts
// 1) 能力声明
export interface ProviderCapabilities {
  currencies: Array<'JPY' | 'USD' | 'CNY' | string>;
  countries: string[];              // 可服务的目的国（'US' / 'CA' / '*'）
  entryMode: 'in_app' | 'copylink' | 'redirect';   // 前端据此渲染入口
  supportsRefund: boolean;          // MVP 全额
  supportsPartialRefund: boolean;
  supportsDispute: boolean;
  minAmountJpy?: number; maxAmountJpy?: number;
  refundableWhenDisabled: boolean;  // 下线后老订单是否仍需可退款（关键）
}

// 2) 注册表 + 工厂（新增支付方式 = 注册一个工厂，业务零改动）
export interface ProviderRegistry {
  register(channel: string, factory: (cfg: ChannelConfig) => PaymentProvider): void;
  get(channel: string): PaymentProvider;
  listAvailable(ctx: { destCountry: string; amountJpy: number }): PaymentProvider[];  // 按 capabilities 过滤
}
```

> **实际签名（AJ-176，以 `server/src/ports/payment.ts` 为准）**：`PaymentRegistry` = `register` / `get(channel)`（**新单**：未注册 / 已禁用即 40001）/
> `getForRefund(channel)`（**老单退款**：已禁用仍可取，但仅当 `capabilities.refundableWhenDisabled`）/ `getForCallback(channel)`（**老单回调**：禁用也不拦）/
> `listAvailable(query: ChannelQuery): ChannelView[]`——`ChannelQuery = { destCountry, amountJpy, currency }`（比上面多了 `currency`），
> 返回的是给前端的视图 `ChannelView = { channel, entryMode, label, icon? }`，**不是** `PaymentProvider[]`。`ProviderCapabilities` 字段与上面一致。

- **配置表 `payment_channels`**：`channel / enabled / priority / countries[] / currencies[] / ~~config(jsonb) / refundable_when_disabled~~`。I1 先用 env `PAYMENT_CHANNELS` 作为 seed 来源，**上线前迁到表**（运行时上下线不发版）
  （AJ-176 实际：`migrations/010_config_tables.sql` 建的列是 `channel / enabled / priority / countries(jsonb) / currencies(jsonb) / label / icon / created_at / updated_at`，**没有** `config(jsonb)` 与 `refundable_when_disabled`——后者是 Provider 的能力声明 `capabilities.refundableWhenDisabled`，不是运营配置。表只有与 `CHANNEL_DEFAULTS` 逐字同源的种子，**消费方未接线**（R2-4），装配仍走 env + 内置表）
- **路由**：`PaymentRouter` 按 `(目的国, 金额, 能力, priority)` 返回可用通道列表；默认实现读表，将来可换成"成本最优 / 成功率最优"策略而不动调用方（⚠️ 现状：没有独立的 `PaymentRouter`，由注册表 `listAvailable` 按装配期的 `ChannelConfig`（env + 内置表）过滤排序，不读表，AJ-176）
- **回调分发**：改为 `/pay/callback/:channel`，由注册表分发；新增通道不改路由、不改 Kong/Nginx（✅ 已落地：`/api/v1/pay/callback/:channel`，AJ-176 核对）
- **下线语义**：通道下线后**已生成的支付单仍必须可退款/可对账**（`refundableWhenDisabled`），禁用只影响新单
- **契约测试复用**：所有 Provider 跑同一组 `test/contract/payment-provider.contract.test.ts`（create / 重复回调 / 迟到回调 / 退款 / 拒付 / 验签失败），**新增支付方式直接复用同一套测试**（呼应《测试策略》T-1/T-3）

### 2.3 前端入口
`GET /pay/channels?country=US&amount=...`（AJ-176 实际参数：`country` / `currency` / `amount_jpy`，三个都必填、无默认值）返回 `[{channel, entryMode, label, icon}]`；小程序按 `entryMode` 渲染：`in_app` → 直接调起；`copylink` → 引导页；`redirect` → 短链。**删掉一个支付方式，前端自动不显示**（现在是两个写死的按钮）。

---

## 3. 多国家（Country Profile）

### 3.1 现状与硬编码清单（必须逐个抽掉）

| 硬编码点 | 现在 | 改为 |
|---|---|---|
| 地址校验 | DB CHECK：ASCII、`^\+1\d{10}$`、`^\d{5}(-\d{4})?$`、`state CHAR(2)` | 按 `country_profiles.address_template` 校验（见 3.2） |
| 运费 | `shipping_rates` 单表按重量 | 加 `dest_country`，三列唯一键（⚠️ **计划，未实现**：`shipping_rates` 至今没有 `dest_country` 列，见 `server/src/adapters/catalog.ts` @limitation 一，AJ-176） |
| 关税 | 常量 `DUTY_RATE_US=0.15`（且只对日原产成立） | `duty_rates(origin_country, dest_country, rate, ~~effective_from~~)`，代码从表读（✅ 已随 010 落地；AJ-176 实际列：`origin_country / dest_country / rate NUMERIC(6,5) / note / created_at / updated_at`，主键 `(origin_country, dest_country)`，**没有** `effective_from`；`DUTY_RATE_US` 配置项已删除） |
| 展示币 | `DISPLAY_CURRENCIES=CNY,USD` | 按目的国 profile 的 `display_currencies` |
| 可邮寄性 | `compliance_tags` 拦截（美国 FDA/CPSIA 口径） | 拦截规则按目的国 profile 的 `blocked_tags` |
| 卖家主体 | `orders.seller_entity DEFAULT 'JP'`（D-53 预留） | 按目的国/通道路由主体 |

### 3.2 目标形态

```ts
export interface CountryProfile {
  code: string;                       // 'US' | 'CA' | …
  active: boolean;
  displayCurrencies: string[];        // ['CNY','USD']
  addressTemplate: {                  // 驱动后端校验 + 前端表单渲染
    fields: Array<{ key: string; label: string; required: boolean;
                    pattern?: string; maxLength?: number; options?: string[] }>;
  };
  phonePattern: string;
  postalPattern: string;
  allowedCarriers: string[];          // ems / dhl / tenso …
  blockedTags: string[];              // 该国不可售的合规标签
  dutyNote: string;                   // 前端展示的关税口径文案（DDP/DDU）
}
```

- **新增 `country_profiles` 表**（MVP seed 仅 `US` 一条，值等于现在硬编码的规则 → 行为不变，零回归）
- **`shipping_rates` 加 `dest_country CHAR(2) NOT NULL DEFAULT 'US'`**，唯一键改 `(carrier, dest_country, max_weight_g)`。⚠️ 取档 SQL 增加 `AND dest_country = $country` 后，**D-46 的 7 条自测向量必须全部保留**（`w=1850 → 4950`），这是回归红线（⚠️ **计划，未实现**：迁移 001–013 均未加此列，取档 SQL 也没有国家条件，AJ-176）
- **`duty_rates` 表**（D-42 已列 P1，此处升为架构必做）：seed 一行 `JP→US = 0.15`；`DUTY_RATE_US` 降级为该表的 seed 值，代码不再读常量（✅ 已随 010 落地，报价从表读；`DUTY_RATE_US` 配置项已删除，AJ-176）
- **地址校验**：应用层改为 country-aware validator（读 profile）；**DB 层 MVP 保留 US 模板约束**（防止绕过，铁律 T-4 同款思路），新增国家时走一条迁移替换约束——不允许只改代码不改约束
- **`products.origin_country='JP'` 约束保留**：将来开放非日产时，必须一条迁移同时删约束 + `duty_rates` 补对应税率（与 §2.5 关税口径联动）

---

## 4. 业务与功能解耦（目录与依赖方向）

> ⚠️ 下面这棵树是**目标形态**（成文时的设想），不是现状目录（AJ-176）。现状目录见树后的「2026-09-28 实际目录」。

```
server/src/
├── domain/            ← 纯业务：订单状态机、金额、库存、定价规则。零依赖 Express / SQL / 三方 SDK
│   ├── orders/        (状态机、迁移守卫、金额计算)
│   ├── catalog/       (上架规则引擎：规则对象 + 注册表)
│   └── pricing/       (运费取档、关税、汇率快照) —— 依赖注入 ShippingQuoter / DutyRates 接口
├── ports/             ← 接口定义（PaymentProvider / ShippingQuoter / Notifier / Storage / FxSource / CountryProfileRepo）
├── adapters/          ← 实现，可增删
│   ├── payment/       (mock / stripe / wechat … 注册表 + 工厂)
│   ├── shipping/      (ems / dhl / tenso)
│   ├── notify/        (订阅消息 / 邮件 / 短信)
│   ├── storage/       (R2)
│   └── fx/            (手动 / 实时 API，P2)
├── events/            ← 领域事件总线：order.paid / shipped / delivered / dispute.created
└── app/               ← 组装层：Express 路由、依赖注入、配置装载
```

**2026-09-28 实际目录**（AJ-176，`ls server/src` 核对）：

```
server/src/
├── domain/     ← 扁平 *.ts，无子目录：order.ts（状态机迁移表）、quote.ts（报价）、order-no.ts、admin-order-actions.ts、
│                 upload-image.ts、*-input.ts（商品 / 地址 / Banner / 汇率 / 运费表 / 拒付的输入校验）
├── ports/      ← payment / events / clock / ids / idempotency / rate-limit / scheduler / storage / webhooks /
│                 wechat-auth / http-client / circuit-breaker
├── adapters/   ← 子目录只有 payment/（mock · stripe-checkout · registry · channels）、http/（fetch-client · circuit-breaker）、
│                 wechat/（code2session · dev-auth）；其余扁平：catalog / orders / orders-admin / addresses / country-profiles /
│                 db / idempotency / webhooks / scheduler / event-bus / storage-fs / storage-memory / image-resize …
│                 （没有 shipping/ notify/ storage/ fx/ 子目录；存储实现是 storage-fs.ts，R2 驱动未实现）
├── events/     ← 只有 .gitkeep；事件总线实际在 adapters/event-bus.ts + ports/events.ts
├── app/        ← 用例 + 路由 + 装配（mount.ts）+ 调度编排
└── （根）      config.ts / http.ts / logger.ts / redact.ts / context.ts / errors.ts / main.ts
```

**依赖方向单向**：`app → domain → ports ← adapters`。`domain` 不允许 import 任何 adapter（用 ESLint `no-restricted-imports` 强制，进 `npm run gate`）。

**副作用走事件**：`order.paid` → 订阅者（扣库存、发订阅消息、通知采购、记对账）；新增一个通知渠道 = 加一个订阅者，订单代码零改动。

**配置表 `app_config`（KV + 类型）**：承载开关与 UI 变体（`REVIEW_MODE`、视觉主题 key、首页 section schema 版本、通道开关），让"改配置"替代"发版"。（⚠️ 现状：表已随 010 建好，刻意零 seed，**消费方未接线**——上面这些开关目前都还在 env，AJ-176）

---

## 5. UI 不写死

| 层 | 做法 | 收益 |
|---|---|---|
| **Design token** | `packages/shared/src/design-tokens.ts` 单一来源（成文时设想放 `miniprogram/theme.ts`，落地时因 admin-web / checkout-static 也要消费而上提到 shared）（色板 / 间距 / 字号 / 圆角），WXSS 用 CSS 变量引用；页面与组件**禁止出现色值与尺寸字面量**（lint 规则） | D1 视觉 A/B（可爱日系 ↔ 轻奢日系）只换一个 token 文件 |
| **组件化** | 6 个基础组件（按钮 / 价格 / 骨架 / 空态 / Toast / Modal）+ 页面只做组合（⚠️ 现状：只有 `ws-button`、`ws-price` 2 个；11 个业务页已落地，原定"真实页面开工时按需建"的触发条件已满足而其余 4 个未建，AJ-176） | 改样式只改组件 |
| **页面区块 schema** | 首页由 `GET /home` 下发 `sections:[{type:'banner'|'category_grid'|'product_grid'|'coupon_bar', props}]`，前端按 `type` 查组件表渲染 | **调整首页布局/增删模块无需发版**（小程序发版要审核，这是刚需） |
| **表单 schema** | 地址表单按 `CountryProfile.addressTemplate` 渲染 | 加国家 = 后端下发模板，前端零改动 |
| **支付入口** | 按 `GET /pay/channels` 的 `entryMode` 渲染 | 增删支付方式前端零改动 |
| **文案外置** | 文案走 i18n 表 + 后端下发（`GET /terms` 已是该模式）；价格/日期走 `format.ts` | 改文案不发版 |
| **禁止清单** | WXML/WXSS 中不得出现：金额、币种符号以外的货币逻辑、税率、国家名、承运商名、模块顺序、色值字面量 | lint + 人工 review 双查 |

---

## 6. 落地影响与建议时序（小步，不一次性大改）

| 优先级 | 改动 | 成本 | 说明 |
|---|---|---|---|
| **P0（写第一行业务代码前就定，零回归）** | 目录分层 `domain/ports/adapters/app` + ESLint 依赖方向约束；`PaymentProvider` 加 `capabilities`；Provider 注册表 + `/pay/callback/:channel`；前端 design token 单源（落地为 `packages/shared/src/design-tokens.ts`）；`app_config` KV 表 | 低 | 不改现有行为，只加扩展点 |
| **P0（同上）** | `country_profiles` 表 + seed（US 一条，值 = 现有硬编码） | 低 | 为后续铺路 |
| **P1（I1 内）** | `shipping_rates` 加 `dest_country`（默认 'US'）+ 取档 SQL 加国家条件（**7 条向量回归必须绿**）；`duty_rates` 表 + seed；`payment_channels` 配置表（AJ-176 现状：`duty_rates` / `payment_channels` / `app_config` 已随 010 建表，`duty_rates` 已接线；`dest_country` **未做**（计划）；`payment_channels` / `app_config` 未接线） | 中 | 需改技术文档 v0.6 / OpenAPI 0.6.0 |
| **P2（真要加国家时）** | 地址校验 country-aware（应用层 + DB 约束迁移）、地址表单 schema 渲染、`seller_entity` 多主体路由 | 中 | 触发条件：新增第一个非美国目的国 |
| **P3（真要加支付时）** | 新 Provider 实现（复用契约测试）、前端入口已自动出现（⚠️ 现状还需同步改 shared `PAYMENT_CHANNEL` 枚举 + 契约 `x-payment-channels` 登记表，见 §0，AJ-176） | 低 | 触发条件：新增第一个新通道 |

**表数变化**：本文成文时写的「13 → 17」基准已失真——002/003 各加过表，基准早非 13。~~正确口径：007 迁移后当前实际 **17 张**（四张新增中 `country_profiles` 已落地，见 `migrations/007`）；`duty_rates` / `payment_channels` / `app_config` 全部落地后为 **20 张**。~~（AJ-176 更正）四张新增已全部建表（`country_profiles` 007；`duty_rates` / `payment_channels` / `app_config` 010），当前 **20 张**（migrations 001–013）——真源：`server/src/adapters/db.db.test.ts` 的表数断言 + `migrations/`，以真源为准。确认后再同步《技术文档》§3 DDL 与 `api-contract`（跨仓同步欠账已登记，见 `docs/地基搭建清单.md` 欠账登记）。

---

## 7. 与测试策略的接口

- 每个适配器**必须通过同一套契约测试**（落地为 `test/contract/payment-provider.contract.test.ts`），新增实现直接复用 → 满足 T-1（先红后绿）与 T-3（依赖要真）
- `shipping` 取档新增国家维度后，**D-46 的 7 条向量仍是红线**（`w=1850 → 4950`）
- `domain/` 是纯函数密集区，天然满足"关键模块分支覆盖率 100%"
- 目录依赖方向检查进 `npm run gate`（ESLint `no-restricted-imports`）
